// Milestone 9 acceptance: a merchant follows an in-world daily routine, appears in the correct location, reacts to a
// defined event and resumes or changes routine appropriately.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('npcs: merchant routine, scene token, reactions, resume and relocate, history, visibility', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp', npcAutonomy: 'reactive' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const join = async (name, role) => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const [pat, viv] = [await join('Pat', 'player'), await join('Viv', 'spectator')];
  const place = (parent, name, visibility = 'public') => ok('POST', `/api/locations/${parent}/children`, { name, x: 5, y: 5, visibility }, gm);
  const town = await place(world.rootLocationId, 'Greyhaven');
  const [house, market, tavern, docks] = [await place(town.id, 'Mara\'s house'), await place(town.id, 'Market'), await place(town.id, 'Tavern'), await place(town.id, 'Docks')];
  const square = await ok('POST', `/api/locations/${market.id}/scenes`, { name: 'Market square', visibility: 'public' }, gm);
  const page = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'Mara the spice merchant', kind: 'npc', visibility: 'party' }, gm);

  const weekdays = [1, 2, 3, 4, 5, 6];
  const mara = {
    pageId: page.id, name: 'Mara', occupation: 'spice merchant', homeLocationId: house.id, visibility: 'party',
    schedule: [
      { from: '07:00', days: weekdays, locationId: market.id, activity: 'Selling spices', sceneId: square.id, x: 3, y: 4 },
      { from: '12:00', days: weekdays, locationId: tavern.id, activity: 'Eating lunch' },
      { from: '13:00', days: weekdays, locationId: market.id, activity: 'Selling spices', sceneId: square.id, x: 3, y: 4 },
      { from: '18:00', locationId: tavern.id, activity: 'Drinking with friends' },
      { from: '21:00', locationId: house.id, activity: 'Sleeping' },
      { from: '09:00', days: [7], locationId: house.id, activity: 'Resting' },
    ],
    reactions: [
      { on: 'rain', activity: 'Sheltering under her awning', locationId: 'stay', minutes: 30, then: 'resume' },
      { on: 'Fire', activity: 'Hiding at home', locationId: 'home', minutes: 120, then: 'relocate', relocate: { from: market.id, to: docks.id } },
    ],
  };

  // GM only; bad data refused.
  assert.equal((await call('POST', `/api/worlds/${world.id}/npcs`, mara, pat)).status, 403);
  assert.equal((await call('GET', `/api/worlds/${world.id}/npcs`, null, pat)).status, 403);
  assert.equal((await call('POST', `/api/worlds/${world.id}/npcs`, { ...mara, schedule: [{ ...mara.schedule[0], from: '25:00' }] }, gm)).status, 400);
  assert.equal((await call('POST', `/api/worlds/${world.id}/npcs`, { ...mara, schedule: [{ ...mara.schedule[0], sceneId: square.id, locationId: tavern.id }] }, gm)).status, 400, 'scene must be at that place');
  assert.equal((await call('POST', `/api/worlds/${world.id}/npcs`, { ...mara, schedule: [{ ...mara.schedule[0], days: [8] }] }, gm)).status, 400);
  const m = await ok('POST', `/api/worlds/${world.id}/npcs`, mara, gm);
  assert.equal(m.effectiveAutonomy, 'reactive');
  const guard = await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'Secret agent', homeLocationId: market.id, visibility: 'gm', autonomy: 'static',
    schedule: [{ from: '00:00', locationId: tavern.id, activity: 'Spying' }], reactions: [{ on: 'fire', activity: 'Fleeing', locationId: 'home' }] }, gm);
  const crier = await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'Town crier', autonomy: 'scheduled', visibility: 'public', homeLocationId: house.id,
    schedule: [{ from: '06:00', locationId: market.id, activity: 'Crying the news' }], reactions: [{ on: 'fire', activity: 'Fleeing', locationId: 'home' }] }, gm);

  const now = async () => Object.fromEntries((await ok('GET', `/api/worlds/${world.id}/npcs`, null, gm)).npcs.map((n) => [n.name, n.now]));
  const tokens = async (tok = gm) => (await ok('GET', `/api/scenes/${square.id}`, null, tok)).tokens.filter((x) => x.npcId);
  const here = async (loc, tok) => (await ok('GET', `/api/locations/${loc.id}`, null, tok)).npcsHere.map((n) => n.name);
  const clock = (b) => ok('POST', `/api/campaigns/${camp.id}/clock`, b, gm);
  const event = (b) => ok('POST', `/api/campaigns/${camp.id}/events`, b, gm);

  // Day 1, 08:00 (campaigns start at 08:00): at her stall, with a token on the market scene.
  let s = await now();
  assert.deepEqual([s.Mara.place, s.Mara.activity, s.Mara.source], ['Market', 'Selling spices', 'routine']);
  assert.deepEqual([s['Secret agent'].place, s['Secret agent'].source], ['Market', 'home'], 'static NPCs stay home');
  let [tok] = await tokens();
  assert.deepEqual([tok.name, tok.x, tok.y, tok.pageId], ['Mara', 3, 4, page.id]);
  assert.deepEqual(await here(market, pat), ['Mara', 'Town crier'], 'the GM-only agent is not shown to players');
  assert.deepEqual(await here(market, viv), ['Town crier'], 'a party NPC is not shown to spectators');
  assert.deepEqual((await tokens(viv)).length, 0);
  assert.deepEqual((await tokens(pat)).map((x) => x.name), ['Mara']);

  // Lunch: she leaves the scene; back at 13:00.
  await clock({ until: '12:30' });
  s = await now();
  assert.deepEqual([s.Mara.place, s.Mara.activity], ['Tavern', 'Eating lunch']);
  assert.equal((await tokens()).length, 0, 'token removed when she leaves');
  assert.deepEqual(await here(tavern, pat), ['Mara']);
  await clock({ advanceMinutes: 60 });
  assert.equal((await now()).Mara.place, 'Market');
  assert.equal((await tokens()).length, 1);

  // Rain at the tavern does not concern her; rain at the market does, then she resumes.
  assert.deepEqual((await event({ kind: 'rain', locationId: tavern.id })).reacted, []);
  const rain = await event({ kind: 'RAIN', locationId: market.id });
  assert.deepEqual(rain.reacted.map((x) => x.name), ['Mara'], 'only NPCs with a matching reaction react');
  s = await now();
  assert.deepEqual([s.Mara.place, s.Mara.activity, s.Mara.source], ['Market', 'Sheltering under her awning', 'reaction']);
  assert.equal((await tokens()).length, 1, 'stays on the scene while sheltering');
  await clock({ advanceMinutes: 30 });
  assert.equal((await now()).Mara.activity, 'Selling spices');

  // Fire anywhere in Greyhaven: reactive Mara flees home; the crier (scheduled only) and the static agent do not react.
  const fire = await event({ kind: 'fire', locationId: town.id, note: 'the spice warehouse burns' });
  assert.deepEqual(fire.reacted.map((x) => x.name), ['Mara']);
  s = await now();
  assert.deepEqual([s.Mara.place, s.Mara.activity], ['Mara\'s house', 'Hiding at home']);
  assert.equal((await tokens()).length, 0);
  // After the fire she moves her trade to the docks for good: new routine, not the old one.
  await clock({ advanceMinutes: 150 });
  s = await now();
  assert.deepEqual([s.Mara.place, s.Mara.activity, s.Mara.source], ['Docks', 'Selling spices', 'routine']);
  assert.deepEqual(await here(market, pat), ['Town crier']);
  assert.deepEqual(await here(docks, pat), ['Mara']);
  await clock({ until: '07:30' });
  assert.equal((await now()).Mara.place, 'Docks', 'next morning: still the new routine');

  // Weekly routine: day 7 is her rest day.
  await clock({ advanceDays: 5 });
  s = await now();
  assert.deepEqual([s.Mara.place, s.Mara.activity], ['Mara\'s house', 'Sleeping'], 'before 09:00 on her rest day: still asleep');
  await clock({ until: '10:00' });
  assert.equal((await now()).Mara.activity, 'Resting');

  // Event history: routine moves, the reaction, the resumption and the relocation, in order.
  const hist = (await ok('GET', `/api/campaigns/${camp.id}/npc-log?npcId=${m.id}`, null, gm)).reverse();
  const kinds = hist.map((x) => `${x.kind}@${x.clock}`);
  for (const k of ['moved@12:00', 'moved@13:00', 'reacted@13:30', 'resumed@14:00', 'reacted@14:00', 'relocated@16:00', 'resumed@16:00', 'moved@18:00', 'moved@21:00'])
    assert.ok(kinds.includes(k), `${k} in ${kinds.join(' ')}`);
  assert.ok(kinds.indexOf('reacted@13:30') < kinds.indexOf('resumed@14:00'));
  assert.ok(hist.some((x) => x.kind === 'summary'), 'a five-day jump is summarised, not logged step by step');
  const all = await ok('GET', `/api/campaigns/${camp.id}/npc-log`, null, gm);
  assert.ok(all.some((x) => x.kind === 'event' && /fire at Greyhaven: the spice warehouse burns/.test(x.text)));
  assert.equal((await call('GET', `/api/campaigns/${camp.id}/npc-log`, null, pat)).status, 403);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/events`, { kind: 'fire' }, pat)).status, 403);

  // GM override: she goes where the GM says, then returns to her routine.
  await ok('POST', `/api/npcs/${m.id}/override`, { activity: 'Meeting the party', locationId: market.id, sceneId: square.id, x: 6, y: 6, minutes: 60 }, gm);
  [tok] = await tokens();
  assert.deepEqual([tok.x, tok.y], [6, 6]);
  await clock({ advanceMinutes: 60 });
  assert.equal((await now()).Mara.activity, 'Resting');
  assert.equal((await tokens()).length, 0);

  // Deleting an NPC removes its token but keeps its history.
  await ok('POST', `/api/npcs/${m.id}/override`, { activity: 'Back', locationId: market.id, sceneId: square.id, minutes: 10 }, gm);
  await ok('DELETE', `/api/npcs/${m.id}`, null, gm);
  assert.equal((await tokens()).length, 0);
  assert.ok((await ok('GET', `/api/campaigns/${camp.id}/npc-log?npcId=${m.id}`, null, gm)).length > 5);
  assert.ok(guard && crier);
});

test('npcs: downtime publish moves NPCs with the clock', async (t) => {
  const { ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'milestone', npcAutonomy: 'scheduled' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const a = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Farm', x: 1, y: 1, visibility: 'party' }, gm);
  const b = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Fair', x: 2, y: 2, visibility: 'party' }, gm);
  await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'Tom', homeLocationId: a.id,
    schedule: [{ from: '06:00', locationId: a.id, activity: 'Farming' }, { from: '08:00', days: [3], locationId: b.id, activity: 'Selling at the fair' }] }, gm);
  const place = async () => (await ok('GET', `/api/worlds/${world.id}/npcs`, null, gm)).npcs[0].now.place;
  assert.equal(await place(), 'Farm');
  const w = await ok('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 2, activities: ['recovery'] }, gm);
  await ok('POST', `/api/downtime/${w.id}/publish`, {}, gm); // day 1 → day 3 (weekday 3), still 08:00
  assert.equal(await place(), 'Fair');
});
