// Persistence. The app reads and mutates plain in-memory arrays (`db`); PostgreSQL is the source of truth.
// On boot every table is loaded; after each mutating request `persist()` writes what changed in one transaction.
// shortcut: changes are found by diffing every mutable row against the last write (append-only tables only check new rows);
// fine to ~10k mutable rows per server, upgrade to explicit per-route writes when worlds outgrow that.
// It is also single-process: run one app server per database until realtime fan-out moves to LISTEN/NOTIFY or Redis.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SPEC = {
  users: ['id', 'name', 'tokenHash'],
  worlds: ['id', 'ownerId', 'name', 'settings', 'rootLocationId'],
  campaigns: ['id', 'worldId', 'name', 'advancement'],
  memberships: ['id', 'userId', 'worldId', 'campaignId', 'role'],
  invites: ['id', 'campaignId', 'worldId', 'role', 'createdBy', 'acceptedBy'],
  maps: ['id', 'worldId', 'locationId', 'name', 'imageUrl'],
  locations: ['id', 'worldId', 'parentId', 'name', 'type', 'x', 'y', 'visibility', 'requiresDiscovery', 'mapId', 'pageId'],
  pages: ['id', 'worldId', 'locationId', 'kind', 'visibility', 'title', 'body', 'gmNotes'],
  relationships: ['id', 'worldId', 'fromId', 'toId', 'kind', 'visibility'],
  discoveries: ['id', 'worldId', 'locationId', 'campaignId'],
  revisions: ['id', 'pageId', 'worldId', 'at', 'actor', 'title', 'body', 'gmNotes', 'kind', 'visibility'],
  scenes: ['id', 'worldId', 'locationId', 'name', 'grid', 'cols', 'rows', 'backgroundUrl', 'visibility', 'fog', 'encounter'],
  tokens: ['id', 'worldId', 'sceneId', 'name', 'x', 'y', 'size', 'color', 'visibility', 'controlledBy', 'pageId', 'characterId'],
  characters: ['id', 'worldId', 'campaignId', 'ownerId', 'ruleset', 'name', 'portraitUrl', 'personality', 'backstory', 'species', 'className',
    'background', 'abilityMethod', 'baseScores', 'backgroundBonus', 'abilities', 'skills', 'feats', 'tools', 'hp', 'conditions', 'inventory', 'currency',
    'weapons', 'spells', 'slotsUsed', 'size', 'armor', 'shield', 'masteries', 'raging', 'deathSaves', 'hitDiceUsed', 'journal'],
  advancements: ['id', 'worldId', 'campaignId', 'characterId', 'kind', 'amount', 'category', 'reason', 'by', 'auto', 'at'],
  rolls: ['id', 'worldId', 'sceneId', 'userId', 'userName', 'characterId', 'label', 'visibility', 'formula', 'mode', 'total', 'parts', 'at'],
  events: ['seq', 'at', 'actor', 'type', 'data'],
};
const COLLECTIONS = Object.keys(SPEC);
const JSON_FIELDS = new Set(['settings', 'advancement', 'fog', 'encounter', 'controlledBy', 'data', 'baseScores', 'backgroundBonus',
  'abilities', 'skills', 'feats', 'tools', 'hp', 'conditions', 'inventory', 'currency', 'parts', 'weapons', 'spells', 'slotsUsed', 'masteries', 'deathSaves', 'journal']);
const APPEND_ONLY = new Set(['events', 'revisions', 'advancements', 'rolls']);
const keyOf = (c) => (c === 'events' ? 'seq' : 'id');
const snake = (f) => f.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const empty = () => Object.fromEntries(COLLECTIONS.map((c) => [c, []]));

// Rows written by earlier versions may lack newer fields; fill the defaults the code assumes.
function upgrade(db) {
  for (const l of db.locations) l.requiresDiscovery ??= false;
  for (const p of db.pages) { p.kind ??= p.locationId ? 'location' : 'lore'; p.visibility ??= 'party'; p.locationId ??= null; }
  for (const i of db.invites) i.acceptedBy ??= null;
  for (const t of db.tokens) t.characterId ??= null;
  for (const c of db.campaigns) c.advancement.levelUp ??= 'confirm';
  for (const c of db.characters) {
    c.weapons ??= []; c.spells ??= []; c.slotsUsed ??= {}; c.armor ??= null; c.shield ??= false; c.masteries ??= []; c.raging ??= false;
    c.deathSaves ??= { successes: 0, failures: 0 }; c.hitDiceUsed ??= 0; c.journal ??= [];
    c.size ??= ['Gnome', 'Halfling'].includes(c.species) ? 'Small' : 'Medium';
  }
  return db;
}

async function migrate(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const dir = path.join(__dirname, 'migrations');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, name), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${name} failed: ${e.message}`);
    } finally { client.release(); }
  }
}

async function load(pool) {
  const db = empty();
  for (const c of COLLECTIONS) {
    const { rows } = await pool.query(`SELECT * FROM ${c} ORDER BY ord`);
    db[c] = rows.map((r) => Object.fromEntries(SPEC[c].map((f) => [f, f === 'at' ? r[snake(f)].toISOString() : r[snake(f)]])));
  }
  return upgrade(db);
}

// In-memory only (tests, demos): same interface, nothing is written.
function memoryStore() {
  return { db: empty(), generation: 0, reloading: false, persist: async () => {}, close: async () => {}, onReload: () => {} };
}

async function postgresStore({ databaseUrl, importFile }) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  await migrate(pool);
  const db = await load(pool);
  let snap = snapshot(db);
  let chain = Promise.resolve();
  let reloadHandler = () => {};

  function snapshot(d) {
    return Object.fromEntries(COLLECTIONS.map((c) => [c, APPEND_ONLY.has(c)
      ? d[c].length
      : new Map(d[c].map((r) => [r[keyOf(c)], JSON.stringify(r)]))]));
  }

  async function write(client, c, row) {
    const cols = SPEC[c].map(snake);
    const vals = SPEC[c].map((f) => (JSON_FIELDS.has(f) && row[f] != null ? JSON.stringify(row[f]) : row[f] ?? null));
    const key = snake(keyOf(c));
    await client.query(
      `INSERT INTO ${c} (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})
       ON CONFLICT (${key}) DO UPDATE SET ${cols.filter((x) => x !== key).map((x) => `${x} = EXCLUDED.${x}`).join(', ')}`, vals);
  }

  async function flush() {
    const next = snapshot(db);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of COLLECTIONS) {
        if (APPEND_ONLY.has(c)) {
          for (const row of db[c].slice(snap[c], next[c])) await write(client, c, row);
          continue;
        }
        const live = new Map(db[c].map((r) => [r[keyOf(c)], r]));
        for (const [k, json] of next[c]) if (snap[c].get(k) !== json) await write(client, c, live.get(k));
        for (const k of snap[c].keys()) if (!next[c].has(k)) await client.query(`DELETE FROM ${c} WHERE ${snake(keyOf(c))} = $1`, [k]);
      }
      await client.query('COMMIT');
      snap = next;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  // Writes are serialised; a failed write reloads memory from the database so it never drifts from what was stored.
  const store = {
    db,
    generation: 0,
    reloading: false,
    persist() {
      const p = chain.then(flush).catch(async (e) => {
        store.generation++;
        store.reloading = true;
        try {
          const fresh = await load(pool);
          for (const c of COLLECTIONS) db[c].splice(0, db[c].length, ...fresh[c]);
          snap = snapshot(db);
          reloadHandler();
        } finally { store.reloading = false; }
        throw e;
      });
      chain = p.catch(() => {});
      return p;
    },
    onReload: (fn) => { reloadHandler = fn; },
    close: () => pool.end(),
  };

  // One-time import of a pre-Postgres data.json into an empty database.
  if (importFile && fs.existsSync(importFile) && !db.users.length) {
    const old = upgrade({ ...empty(), ...JSON.parse(fs.readFileSync(importFile, 'utf8')) });
    for (const c of COLLECTIONS) db[c].push(...old[c]);
    await store.persist();
    console.log(`Imported ${importFile} into PostgreSQL; the file is no longer used and can be archived.`);
  }
  return store;
}

module.exports = { memoryStore, postgresStore, COLLECTIONS };
