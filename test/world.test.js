// Milestone 11 acceptance: the GM advances two in-world weeks and reviews plausible, consistent NPC and faction
// developments before committing them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('world simulation: two weeks previewed, decided, committed consistently', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp', npcAutonomy: 'reactive' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const pat = await user('Pat');
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, pat);
  const place = (parent, name) => ok('POST', `/api/locations/${parent}/children`, { name, x: 5, y: 5, visibility: 'public' }, gm);
  const town = await place(world.rootLocationId, 'Greyhaven');
  const [market, docks, mill, road] = [await place(town.id, 'Market'), await place(town.id, 'Docks'), await place(town.id, 'Old mill'), await place(world.rootLocationId, 'King\'s road')];
  await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'Harbourmaster', homeLocationId: docks.id, visibility: 'party',
    schedule: [{ from: '00:00', locationId: docks.id, activity: 'Keeping watch' }], reactions: [{ on: 'smuggling', activity: 'Counting crates', locationId: 'stay', minutes: 120 }] }, gm);
  const jory = await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'Jory', occupation: 'travelling merchant', homeLocationId: road.id, visibility: 'party', autonomy: 'scheduled',
    schedule: [{ from: '00:00', locationId: road.id, activity: 'Travelling' }] }, gm);

  const guild = await ok('POST', `/api/worlds/${world.id}/factions`, { name: 'Merchant Guild', visibility: 'party', influence: 40, resources: 30, leader: 'Mistress Oda',
    territory: [market.id], standings: { party: 10 },
    activities: [
      { name: 'Recruit', every: 7, cost: 20, significance: 'minor', effects: [{ kind: 'influence', delta: 5 }] },
      { name: 'Talk up prices', every: 5, significance: 'routine', effects: [{ kind: 'rumour', text: 'The guild says prices will fall.' }] },
    ] }, gm);
  const sail = await ok('POST', `/api/worlds/${world.id}/factions`, { name: 'Black Sail', visibility: 'gm', influence: 30, resources: 30, standings: { [guild.id]: -20 },
    activities: [
      { name: 'Smuggling run', every: 4, cost: 10, significance: 'minor', effects: [{ kind: 'resources', delta: 25 }, { kind: 'event', eventKind: 'smuggling', locationId: docks.id },
        { kind: 'rumour', text: 'Crates go missing at night.', visibility: 'gm' }] },
      { name: 'Seize the old mill', every: 14, significance: 'minor', effects: [{ kind: 'territory', locationId: mill.id }] },
      { name: 'Lean on the guild', every: 7, significance: 'minor', effects: [{ kind: 'standing', target: guild.id, delta: -30 }] },
      { name: 'Murder the mayor', every: 3, significance: 'protected', effects: [{ kind: 'influence', delta: 40 }] },
    ] }, gm);
  assert.equal((await call('POST', `/api/worlds/${world.id}/factions`, { name: 'x', activities: [{ name: 'a', effects: [{ kind: 'standing', target: 'nobody', delta: 1 }] }] }, gm)).status, 404);
  assert.equal((await call('POST', `/api/worlds/${world.id}/factions`, { name: 'x', influence: 500 }, gm)).status, 400);
  // The travelling merchant reaches Greyhaven in the second week.
  const arrival = await ok('POST', `/api/campaigns/${camp.id}/happenings`, { inDays: 9, label: 'Jory reaches Greyhaven', effects: [
    { kind: 'npc', npcId: jory.id, locationId: market.id, activity: 'Selling exotic wares', minutes: 5 * 1440 },
    { kind: 'rumour', text: 'A merchant from the south has arrived with spices.', locationId: market.id }] }, gm);

  // GM only.
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/simulate`, { days: 14 }, pat)).status, 403);
  assert.equal((await call('POST', `/api/worlds/${world.id}/factions`, { name: 'x' }, pat)).status, 403);
  const playerWorld = await ok('GET', `/api/campaigns/${camp.id}/world`, null, pat);
  assert.deepEqual(playerWorld.factions.map((f) => [f.name, f.towardParty]), [['Merchant Guild', 'neutral']], 'the hidden ring is not listed; standings as words');

  const before = await ok('GET', `/api/campaigns/${camp.id}/world`, null, gm);
  const preview = (decisions = {}) => ok('POST', `/api/campaigns/${camp.id}/simulate`, { days: 14, decisions }, gm);
  let sim = await preview();
  const again = await preview();
  assert.equal(sim.hash, again.hash, 'deterministic: the same preview twice');
  const after = await ok('GET', `/api/campaigns/${camp.id}/world`, null, gm);
  assert.deepEqual(after.factions.map((f) => f.current), before.factions.map((f) => f.current), 'a preview changes nothing');
  assert.equal(after.now, before.now);

  // Plausible and consistent: in time order, within the fortnight, each step built on the previous one.
  const devs = sim.developments;
  for (let i = 1; i < devs.length; i++) assert.ok(devs[i].time >= devs[i - 1].time);
  const by = (src) => devs.filter((d) => d.source === src);
  const recruits = by('Merchant Guild: Recruit');
  assert.equal(recruits.length, 2);
  assert.deepEqual([recruits[0].status, recruits[1].status], ['approved', 'skipped'], 'the guild cannot afford a second recruitment drive');
  assert.match(recruits[1].reason, /needs 20 resources, has 10/);
  const runs = by('Black Sail: Smuggling run');
  assert.ok(runs.length >= 3);
  const res = runs.map((r) => r.effects.find((e) => e.kind === 'resources'));
  for (let i = 1; i < res.length; i++) assert.equal(res[i].before, res[i - 1].after - 10, 'each run pays 10 then earns 25 on top of the last');
  assert.ok(runs.every((r) => r.reactions.some((x) => x.startsWith('Harbourmaster'))), 'the NPCs who would react are shown');
  const seize = by('Black Sail: Seize the old mill')[0];
  const leans = by('Black Sail: Lean on the guild');
  const lean = leans[0];
  assert.equal(leans.length, 2, 'every 7 days: twice in a fortnight');
  assert.deepEqual([seize.significance, seize.status], ['major', 'undecided'], 'territory changes are major');
  assert.deepEqual([lean.significance, lean.status], ['major', 'undecided'], 'a swing of 30 is past the threshold of 25');
  assert.ok(by('Black Sail: Murder the mayor').every((d) => d.status === 'blocked'), 'protected developments never commit');
  const jo = devs.find((d) => d.source === 'Scheduled: Jory reaches Greyhaven');
  assert.ok(jo.effects[0].summary.startsWith('Jory goes to Market'));
  assert.equal(sim.undecided, 3);

  // Commit refuses undecided majors and stale previews.
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/simulate/commit`, { days: 14, hash: sim.hash }, gm)).status, 409);
  const decisions = { [seize.id]: 'rejected', [leans[0].id]: 'approved', [leans[1].id]: 'rejected',
    ...Object.fromEntries(by('Merchant Guild: Talk up prices').map((d) => [d.id, 'rejected'])) };
  sim = await preview(decisions);
  assert.equal(sim.undecided, 0);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/simulate/commit`, { days: 14, decisions, hash: again.hash }, gm)).status, 409, 'decisions changed the draft');
  const done = await ok('POST', `/api/campaigns/${camp.id}/simulate/commit`, { days: 14, decisions, hash: sim.hash }, gm);
  assert.equal(done.applied, sim.developments.filter((d) => d.status === 'approved').length);

  // Canon now equals what the GM reviewed.
  const w = await ok('GET', `/api/campaigns/${camp.id}/world`, null, gm);
  const cur = Object.fromEntries(w.factions.map((f) => [f.name, f.current]));
  const end = Object.fromEntries(sim.factions.map((f) => [f.name, f]));
  for (const name of ['Merchant Guild', 'Black Sail']) {
    assert.equal(cur[name].influence, end[name].influence, `${name} influence`);
    assert.equal(cur[name].resources, end[name].resources, `${name} resources`);
  }
  assert.equal(cur['Black Sail'].standings[guild.id], -50);
  assert.ok(!cur['Black Sail'].territory.includes(mill.id), 'the rejected seizure did not happen');
  assert.equal(cur['Black Sail'].influence, 30, 'the protected murder did not happen');
  assert.equal(w.now, sim.to, 'the clock moved two weeks');
  assert.equal(w.happenings.find((x) => x.id === arrival.id).status, 'done');
  // Provenance: every change names its rule, its commit and who approved it.
  assert.ok(w.history.every((x) => x.source && x.commitId && x.by));
  assert.ok(w.history.some((x) => x.source === 'Black Sail: Smuggling run (cost)'));
  // NPCs: the merchant is at the market for the second week; the harbourmaster's reactions are in the history.
  const npcs = await ok('GET', `/api/worlds/${world.id}/npcs`, null, gm);
  const j = npcs.npcs.find((n) => n.name === 'Jory').now;
  assert.deepEqual([j.place, j.activity], ['Market', 'Selling exotic wares']);
  const log = await ok('GET', `/api/campaigns/${camp.id}/npc-log`, null, gm);
  assert.ok(log.filter((x) => x.kind === 'reacted' && /Harbourmaster reacts to the smuggling/.test(x.text)).length >= 3);

  // Players: their rumours only (the rejected guild talk and the GM-only crates rumour are absent).
  const pw = await ok('GET', `/api/campaigns/${camp.id}/world`, null, pat);
  assert.deepEqual(pw.rumours.map((r) => r.text), ['A merchant from the south has arrived with spices.']);
  assert.ok(!JSON.stringify(pw).includes('Black Sail'));

  // A GM decision outside the simulation: the party helped the guild.
  await ok('POST', `/api/campaigns/${camp.id}/world-changes`, { note: 'The party drove off the bandits', effects: [{ kind: 'standing', factionId: guild.id, target: 'party', delta: 20 }] }, gm);
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/world`, null, pat)).factions[0].towardParty, 'friendly');
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/world-changes`, { effects: [{ kind: 'influence', factionId: guild.id, delta: 5 }] }, pat)).status, 403);
  // The old preview is stale now.
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/simulate/commit`, { days: 14, decisions, hash: sim.hash }, gm)).status, 409);
  assert.ok(sail);
});

test('world simulation: chance is bounded and repeatable', async (t) => {
  const { ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  await ok('POST', `/api/worlds/${world.id}/factions`, { name: 'Bandits', activities: [{ name: 'Raid', every: 1, chance: 50, significance: 'routine', effects: [{ kind: 'resources', delta: 1 }] }] }, gm);
  const sim = await ok('POST', `/api/campaigns/${camp.id}/simulate`, { days: 28 }, gm);
  const n = sim.developments.length;
  assert.ok(n > 3 && n < 25, `about half of 28 days, got ${n}`);
  assert.deepEqual((await ok('POST', `/api/campaigns/${camp.id}/simulate`, { days: 28 }, gm)).developments.map((d) => d.id), sim.developments.map((d) => d.id));
});
