// Milestone 13: NPC performance and simulation consistency.
// - Thousands of NPCs cost nothing until time moves, and moving time stays fast and bounded.
// - The world simulation is consistent: committing 7 days then 7 days gives exactly the 14-day preview; values stay
//   inside their bounds over a long run; a preview never changes anything.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

const timed = async (fn) => { const t = performance.now(); const r = await fn(); return [r, performance.now() - t]; };

test('NPC performance: 3,000 NPCs over a day, a month, and a town-wide event', async (t) => {
  const { app, ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'Big', advancement: 'xp', npcAutonomy: 'reactive' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'City', x: 1, y: 1, visibility: 'public' }, gm);
  const places = [];
  for (let i = 0; i < 20; i++) places.push(await ok('POST', `/api/locations/${town.id}/children`, { name: `Ward ${i}`, x: i, y: i, visibility: 'public' }, gm));
  const square = await ok('POST', `/api/locations/${places[0].id}/scenes`, { name: 'Square', cols: 40, rows: 40, visibility: 'public' }, gm);
  // 3,000 townsfolk with a four-step day; 40 of them stand on the square during the day (tokens).
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const work = places[i % 20].id, home = places[(i + 7) % 20].id;
    const onSquare = i < 40;
    app.db.npcs.push({ id: `npc-${i}`, worldId: world.id, pageId: null, name: `Townsperson ${i}`, occupation: 'worker', homeLocationId: home, visibility: 'public', autonomy: 'inherit',
      importance: 'background', color: '#556677', reactions: [{ on: 'fire', activity: 'Fleeing', locationId: 'home', sceneId: null, x: null, y: null, minutes: 120, then: 'resume', relocate: null }],
      schedule: [{ from: 360, days: [], locationId: home, activity: 'Breakfast', sceneId: null, x: null, y: null },
        { from: 480, days: [], locationId: onSquare ? places[0].id : work, activity: 'Working', ...(onSquare ? { sceneId: square.id, x: i % 40, y: Math.floor(i / 40) } : { sceneId: null, x: null, y: null }) },
        { from: 1080, days: [], locationId: places[3].id, activity: 'At the tavern', sceneId: null, x: null, y: null },
        { from: 1320, days: [], locationId: home, activity: 'Sleeping', sceneId: null, x: null, y: null }] });
  }
  // Listing them all (where everyone is now): one pass.
  const [list, listMs] = await timed(() => ok('GET', `/api/worlds/${world.id}/npcs`, null, gm));
  assert.equal(list.npcs.length, N);
  // A day passes: every step of every NPC is logged; tokens follow.
  const logBefore = app.db.npcLog.length;
  const [, dayMs] = await timed(() => ok('POST', `/api/campaigns/${camp.id}/clock`, { advanceDays: 1 }, gm));
  const dayLog = app.db.npcLog.length - logBefore;
  assert.ok(dayLog >= N * 3 && dayLog <= N * 5, `${dayLog} log lines for a day`);
  assert.equal(app.db.tokens.filter((x) => x.npcId).length, 40, 'the 40 on the square have tokens at 08:00');
  // A month passes: one summary line per NPC, not 120,000 steps.
  const beforeMonth = app.db.npcLog.length;
  const [, monthMs] = await timed(() => ok('POST', `/api/campaigns/${camp.id}/clock`, { advanceDays: 30 }, gm));
  assert.equal(app.db.npcLog.length - beforeMonth, N, 'bounded: a summary per NPC');
  // A fire across the whole city: everyone reacts.
  const [fire, fireMs] = await timed(() => ok('POST', `/api/campaigns/${camp.id}/events`, { kind: 'fire', locationId: town.id }, gm));
  assert.equal(fire.reacted.length, N);
  assert.equal(app.db.tokens.filter((x) => x.npcId).length, 0, 'everyone fled the square');
  // Budgets: generous for slow CI machines, but far below anything a GM would notice as a hang.
  const budget = 5000;
  for (const [what, ms] of [['list', listMs], ['day', dayMs], ['month', monthMs], ['fire', fireMs]]) assert.ok(ms < budget, `${what} took ${Math.round(ms)} ms`);
  t.diagnostic(`3,000 NPCs: list ${Math.round(listMs)} ms, one day ${Math.round(dayMs)} ms (${dayLog} steps), 30 days ${Math.round(monthMs)} ms, city-wide event ${Math.round(fireMs)} ms`);
});

test('simulation consistency: 7 + 7 days equals the 14-day preview; bounded over a year', async (t) => {
  const { app, ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const place = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Vale', x: 1, y: 1 }, gm);
  const a = await ok('POST', `/api/worlds/${world.id}/factions`, { name: 'Guild', resources: 40, influence: 50 }, gm);
  const b = await ok('POST', `/api/worlds/${world.id}/factions`, { name: 'Bandits', resources: 20, influence: 30, standings: { [a.id]: -10 } }, gm);
  await ok('PATCH', `/api/factions/${a.id}`, { activities: [
    { name: 'Trade', every: 1, chance: 60, significance: 'routine', effects: [{ kind: 'resources', delta: 7 }] },
    { name: 'Hire guards', every: 3, chance: 70, cost: 15, significance: 'minor', effects: [{ kind: 'influence', delta: 4 }, { kind: 'standing', target: b.id, delta: -5 }] },
    { name: 'Gossip', every: 2, chance: 50, significance: 'routine', effects: [{ kind: 'rumour', text: 'The guild is hiring.' }] }] }, gm);
  await ok('PATCH', `/api/factions/${b.id}`, { activities: [
    { name: 'Raid', every: 2, chance: 55, cost: 5, significance: 'minor', effects: [{ kind: 'resources', delta: 12 }, { kind: 'influence', delta: 3 }, { kind: 'standing', target: a.id, delta: -6 }] },
    { name: 'Lie low', every: 5, chance: 80, significance: 'routine', effects: [{ kind: 'influence', delta: -2 }] }] }, gm);
  assert.ok(place);
  const sim = (days) => ok('POST', `/api/campaigns/${camp.id}/simulate`, { days }, gm);
  const commit = async (days) => { const p = await sim(days); return ok('POST', `/api/campaigns/${camp.id}/simulate/commit`, { days, hash: p.hash }, gm); };
  const state = async () => (await ok('GET', `/api/campaigns/${camp.id}/world`, null, gm)).factions.map((f) => [f.name, f.current.influence, f.current.resources, f.current.standings]);

  const preview14 = await sim(14);
  assert.ok(preview14.developments.length > 10, 'a busy fortnight');
  assert.equal(preview14.undecided, 0);
  const expected = preview14.factions.map((f) => [f.name, f.influence, f.resources]);
  const rumoursExpected = preview14.developments.filter((d) => d.status === 'approved' && d.effects.some((e) => e.kind === 'rumour')).length;
  await commit(7);
  await commit(7);
  assert.deepEqual((await state()).map(([n, i, r]) => [n, i, r]), expected, 'two weeks in two steps = one two-week preview');
  assert.equal(app.db.worldChanges.filter((x) => x.kind === 'rumour').length, rumoursExpected);
  // Replaying the change log from the starting values gives the same state (what a restart does).
  const replay = Object.fromEntries(app.db.factions.map((f) => [f.id, { influence: f.influence, resources: f.resources }]));
  for (const ch of app.db.worldChanges) if (ch.kind === 'influence' || ch.kind === 'resources') replay[ch.data.factionId][ch.kind] += ch.data.delta;
  assert.deepEqual(app.db.factions.map((f) => [f.name, replay[f.id].influence, replay[f.id].resources]), expected);

  // A year: bounded values, no runaway, every change within the rules' sizes.
  const [, yearMs] = await timed(() => commit(365));
  const year = await state();
  for (const [, influence, resources, standings] of year) {
    assert.ok(influence >= 0 && influence <= 100);
    assert.ok(resources >= 0);
    for (const v of Object.values(standings)) assert.ok(v >= -100 && v <= 100);
  }
  const maxDelta = Math.max(...app.db.worldChanges.filter((x) => x.kind === 'influence').map((x) => Math.abs(x.data.delta)));
  assert.ok(maxDelta <= 4, 'no change bigger than its rule');
  assert.ok(yearMs < 10000, `a year took ${Math.round(yearMs)} ms`);
  t.diagnostic(`a year of two factions: ${app.db.worldChanges.length} changes, committed in ${Math.round(yearMs)} ms`);
});
