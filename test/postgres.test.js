// PostgreSQL storage: round-trip, legacy import, and recovery from a failed write. Needs TEST_DATABASE_URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot, DB, resetDatabase } = require('./helpers.js');
const { postgresStore } = require('../store.js');

const skip = DB ? false : 'set TEST_DATABASE_URL to run PostgreSQL tests';

test('everything survives a restart exactly', { skip }, async () => {
  const a = await boot();
  const gm = (await a.ok('POST', '/api/users', { name: 'Gm' })).token;
  const pl = (await a.ok('POST', '/api/users', { name: 'Pat' })).token;
  const w = await a.ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm);
  const c = await a.ok('POST', `/api/worlds/${w.id}/campaigns`, { name: 'C1' }, gm);
  await a.ok('POST', `/api/invites/${(await a.ok('POST', `/api/campaigns/${c.id}/invites`, {}, gm)).code}/accept`, {}, pl);
  const town = await a.ok('POST', `/api/locations/${w.rootLocationId}/children`, { name: 'Greyhaven', x: 1, y: 2, requiresDiscovery: true }, gm);
  await a.ok('PUT', `/api/locations/${town.id}/discovery`, { campaignId: c.id, discovered: true }, gm);
  const npc = await a.ok('POST', `/api/worlds/${w.id}/pages`, { title: 'Mara', kind: 'npc', body: 'Lives in [[Greyhaven]].' }, gm);
  await a.ok('PATCH', `/api/pages/${npc.id}`, { gmNotes: 'Spy.' }, gm);
  const rel = await a.ok('POST', `/api/worlds/${w.id}/relationships`, { fromId: npc.id, toId: town.pageId, kind: 'lives in' }, gm);
  await a.ok('POST', `/api/worlds/${w.id}/relationships`, { fromId: town.pageId, toId: npc.id, kind: 'home of' }, gm);
  await a.ok('DELETE', `/api/relationships/${rel.id}`, null, gm);
  const scene = await a.ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', visibility: 'party' }, gm);
  const me = (await a.ok('GET', `/api/worlds/${w.id}`, null, gm)).members[0].userId;
  const hero = await a.ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Hero', x: 1, y: 1, controlledBy: [me] }, gm);
  const gob = await a.ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Gob', x: 2, y: 2, visibility: 'gm' }, gm);
  await a.ok('PATCH', `/api/tokens/${hero.id}`, { x: 5, y: 4 }, pl);
  await a.ok('PATCH', `/api/scenes/${scene.id}`, { fogEnabled: true }, gm);
  await a.ok('POST', `/api/scenes/${scene.id}/fog`, { x0: 0, y0: 0, x1: 2, y1: 2, reveal: true }, gm);
  await a.ok('PUT', `/api/scenes/${scene.id}/encounter`, { combatants: [{ tokenId: hero.id, initiative: 12 }, { tokenId: gob.id, initiative: 3 }] }, gm);
  await a.ok('POST', `/api/scenes/${scene.id}/encounter/next`, null, gm);
  await a.ok('DELETE', `/api/tokens/${gob.id}`, null, gm);
  const ch = (await a.ok('POST', `/api/campaigns/${c.id}/characters`, { name: 'Brann', species: 'Human', className: 'Rogue', background: 'Criminal',
    abilityMethod: 'standard', baseScores: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 }, backgroundBonus: { dex: 2, int: 1 },
    classSkills: ['Acrobatics', 'Deception', 'Insight', 'Perception'], speciesSkills: ['Survival'] }, pl)).character;
  await a.ok('PATCH', `/api/characters/${ch.id}`, { inventory: [{ name: 'Dagger', qty: 2 }], conditions: ['Prone'], currency: { sp: 7 } }, pl);
  await a.ok('POST', `/api/campaigns/${c.id}/xp`, { amount: 450, reason: 'Heist', category: 'quest' }, gm);
  await a.ok('POST', `/api/characters/${ch.id}/level-up`, null, gm);
  await a.ok('POST', `/api/characters/${ch.id}/hp`, { damage: 3 }, pl);
  await a.ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'x', x: 3, y: 3, characterId: ch.id }, gm);
  await a.ok('POST', `/api/worlds/${w.id}/rolls`, { characterId: ch.id, check: 'skill:Stealth', mode: 'advantage', sceneId: scene.id }, pl);
  const before = JSON.stringify(a.app.db);
  await a.close();

  const b = await boot({ store: await postgresStore({ databaseUrl: DB }) }); // same database, migrations already applied
  try {
    assert.deepEqual(b.app.db, JSON.parse(before)); // deep: jsonb does not keep key order
    assert.equal((await b.ok('GET', `/api/pages/${npc.id}`, null, pl)).page.body, `Lives in [[${town.pageId}|Greyhaven]].`);
    assert.equal((await b.ok('GET', `/api/scenes/${scene.id}`, null, pl)).tokens[0].x, 5);
    const sheet = await b.ok('GET', `/api/characters/${ch.id}`, null, pl);
    assert.deepEqual([sheet.level, sheet.xp, sheet.history.length], [2, 450, 2]);
  } finally { await b.close(); }
});

test('a pre-Postgres data.json is imported once into an empty database', { skip }, async () => {
  await resetDatabase();
  // Shape written by Milestone 1: pages without kind/visibility, locations without requiresDiscovery.
  const u = { id: 'u1', name: 'Gm', tokenHash: 'h' };
  const legacy = {
    users: [u],
    worlds: [{ id: 'w1', ownerId: 'u1', name: 'Old', settings: { advancement: 'xp' }, rootLocationId: 'l1' }],
    locations: [{ id: 'l1', worldId: 'w1', parentId: null, name: 'Old', type: 'world', x: 50, y: 50, visibility: 'public', mapId: 'm1', pageId: 'p1' }],
    maps: [{ id: 'm1', worldId: 'w1', locationId: 'l1', name: 'Old map', imageUrl: '' }],
    pages: [{ id: 'p1', worldId: 'w1', locationId: 'l1', title: 'Old', body: 'Lore', gmNotes: '' }],
    events: [{ seq: 1, at: '2026-11-11T10:00:00.000Z', actor: 'u1', type: 'world.created', data: {} }],
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lq-')), 'data.json');
  fs.writeFileSync(file, JSON.stringify(legacy));
  const s1 = await postgresStore({ databaseUrl: DB, importFile: file });
  assert.equal(s1.db.pages[0].kind, 'location');
  assert.equal(s1.db.locations[0].requiresDiscovery, false);
  await s1.close();
  const s2 = await postgresStore({ databaseUrl: DB, importFile: file }); // not empty any more: no second import
  assert.equal(s2.db.users.length, 1);
  assert.equal(s2.db.events[0].at, '2026-11-11T10:00:00.000Z');
  await s2.close();
});

test('a failed write is reported and memory returns to what is stored', { skip }, async () => {
  const a = await boot();
  try {
    const gm = (await a.ok('POST', '/api/users', { name: 'Gm' })).token;
    const w = await a.ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm);
    const { Client } = require('pg');
    const c = new Client({ connectionString: DB });
    await c.connect();
    await c.query("ALTER TABLE pages ADD CONSTRAINT test_short_titles CHECK (length(title) < 20)");
    await c.end();
    const bad = await a.call('POST', `/api/worlds/${w.id}/pages`, { title: 'A title that is far too long' }, gm);
    assert.equal(bad.status, 500);
    assert.ok(!a.app.db.pages.some((p) => p.title.startsWith('A title')), 'unsaved page removed from memory');
    assert.ok(!a.app.db.events.some((e) => e.type === 'page.created'), 'its event too');
    await a.ok('POST', `/api/worlds/${w.id}/pages`, { title: 'Short' }, gm);
    assert.deepEqual((await a.ok('GET', `/api/worlds/${w.id}/pages`, null, gm)).map((p) => p.title), ['Aster', 'Short']);
  } finally { await a.close(); }
});
