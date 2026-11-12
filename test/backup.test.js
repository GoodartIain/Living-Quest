// Milestone 13: backup and restore. A world with data in every table is backed up through the scripts while the app
// runs, restored into a second, empty database, and must come back exactly; the restored app works.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { boot, DB } = require('./helpers.js');
const { postgresStore } = require('../store.js');

const skip = !DB && 'set TEST_DATABASE_URL to run the PostgreSQL backup test';

async function freshDatabase(url) {
  const { Client } = require('pg');
  const u = new URL(url);
  const name = u.pathname.slice(1);
  const admin = new Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).href });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
}

test('backup while running, restore into an empty database, identical and working', { skip }, async () => {
  const a = await boot();
  const restoreUrl = Object.assign(new URL(DB), { pathname: `${new URL(DB).pathname}_restore` }).href;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lq-backup-'));
  const file = path.join(dir, 'backup.json');
  try {
    // A busy world: accounts, wiki, scenes, characters, chat, downtime, side quests, NPCs, factions, broadcast.
    const reg = await a.ok('POST', '/api/auth/register', { name: 'Gm', email: 'gm@example.test', password: 'gm password here' });
    const gm = reg.token;
    const pat = (await a.ok('POST', '/api/users', { name: 'Pat' })).token;
    const w = await a.ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp', npcAutonomy: 'reactive' }, gm);
    const c = await a.ok('POST', `/api/worlds/${w.id}/campaigns`, { name: 'C' }, gm);
    await a.ok('POST', `/api/invites/${(await a.ok('POST', `/api/campaigns/${c.id}/invites`, {}, gm)).code}/accept`, {}, pat);
    const town = await a.ok('POST', `/api/locations/${w.rootLocationId}/children`, { name: 'Greyhaven', x: 1, y: 2, visibility: 'party' }, gm);
    const page = await a.ok('POST', `/api/worlds/${w.id}/pages`, { title: 'Mara', kind: 'npc', body: 'Lives in [[Greyhaven]].' }, gm);
    await a.ok('PATCH', `/api/pages/${page.id}`, { gmNotes: 'Spy.' }, gm);
    const scene = await a.ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', visibility: 'party' }, gm);
    await a.ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Herald', x: 1, y: 1 }, gm);
    await a.ok('POST', `/api/scenes/${scene.id}/triggers`, { name: 'Bell', x: 2, y: 2, event: { kind: 'alarm' } }, gm);
    const ch = (await a.ok('POST', `/api/campaigns/${c.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
      baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat)).character;
    await a.ok('POST', `/api/campaigns/${c.id}/xp`, { amount: 300, reason: 'Heist', category: 'quest' }, gm);
    await a.ok('POST', `/api/worlds/${w.id}/rolls`, { characterId: ch.id, check: 'skill:Stealth' }, pat);
    await a.ok('POST', `/api/campaigns/${c.id}/chat`, { channel: 'table', text: 'Hello' }, pat);
    await a.ok('POST', `/api/worlds/${w.id}/npcs`, { name: 'Jory', homeLocationId: town.id, schedule: [{ from: '09:00', locationId: town.id, activity: 'Selling', sceneId: scene.id, x: 3, y: 3 }] }, gm);
    const fac = await a.ok('POST', `/api/worlds/${w.id}/factions`, { name: 'Guild', activities: [{ name: 'Grow', every: 1, effects: [{ kind: 'influence', delta: 1 }] }] }, gm);
    const sim = await a.ok('POST', `/api/campaigns/${c.id}/simulate`, { days: 3 }, gm);
    await a.ok('POST', `/api/campaigns/${c.id}/simulate/commit`, { days: 3, hash: sim.hash }, gm);
    await a.ok('POST', `/api/campaigns/${c.id}/quests`, { title: 'Find the ledger', objectives: [{ text: 'Search' }] }, gm);
    const adv = await a.ok('POST', `/api/worlds/${w.id}/adventures`, { title: 'Ledger', nodes: { start: { text: 'Go?', choices: [{ label: 'Yes', to: 'end' }] }, end: { text: 'Done', effects: [{ type: 'gp', amount: 5 }] } } }, gm);
    const dt = await a.ok('POST', `/api/campaigns/${c.id}/downtime`, { duration: 5, activities: ['training', { key: 'l', name: 'Ledger', days: 1, adventureId: adv.id }] }, gm);
    await a.ok('POST', `/api/downtime/${dt.id}/actions`, { characterId: ch.id, activity: 'l', startDay: dt.startDay }, pat);
    await a.ok('PATCH', `/api/campaigns/${c.id}/broadcast`, { enabled: true, sceneId: scene.id, lowerThird: 'Live' }, gm);
    assert.ok(fac);
    const before = JSON.parse(JSON.stringify(a.app.db));
    assert.ok(Object.entries(before).filter(([, rows]) => rows.length).length >= 25, 'most tables have rows');

    // Back up while the server is up.
    execFileSync(process.execPath, ['scripts/backup.js', file], { env: { ...process.env, DATABASE_URL: DB }, stdio: 'pipe' });
    const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(backup.format, 'living-quest-backup');
    assert.equal(backup.migrations.at(-1), '017_accounts.sql');
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600', 'private to the owner');

    // Restore into an empty database: identical.
    await freshDatabase(restoreUrl);
    execFileSync(process.execPath, ['scripts/restore.js', file], { env: { ...process.env, DATABASE_URL: restoreUrl }, stdio: 'pipe' });
    const b = await boot({ store: await postgresStore({ databaseUrl: restoreUrl }) });
    try {
      assert.deepEqual(b.app.db, before);
      // The restored app works: the GM signs in with the same password and sees the world.
      const token = (await b.ok('POST', '/api/auth/login', { email: 'gm@example.test', password: 'gm password here' })).token;
      assert.deepEqual((await b.ok('GET', '/api/me', null, token)).worlds.map((x) => x.name), ['Aster']);
      assert.equal((await b.ok('GET', `/api/characters/${ch.id}`, null, token)).xp, 300);
    } finally { await b.close(); }

    // Refusals: a non-empty database, and a backup from a newer version.
    assert.throws(() => execFileSync(process.execPath, ['scripts/restore.js', file], { env: { ...process.env, DATABASE_URL: restoreUrl }, stdio: 'pipe' }), /not empty/);
    fs.writeFileSync(file, JSON.stringify({ ...backup, migrations: [...backup.migrations, '999_future.sql'] }));
    await freshDatabase(restoreUrl);
    assert.throws(() => execFileSync(process.execPath, ['scripts/restore.js', file], { env: { ...process.env, DATABASE_URL: restoreUrl }, stdio: 'pipe' }), /newer version/);
  } finally {
    await a.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
