// Milestone 8 acceptance: a GM creates three in-game weeks of downtime; players book activities independently;
// the GM publishes approved results with no overlapping calendars and no unique resource granted twice.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('downtime: three weeks, independent bookings, conflicts, one publish', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const join = async (name, role = 'player') => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const [pat, ana, viv] = [await join('Pat'), await join('Ana'), await join('Viv', 'spectator')];
  const make = (name, tok) => ok('POST', `/api/campaigns/${camp.id}/characters`, { name, species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, tok);
  const brann = (await make('Brann', pat)).character;
  const mira = (await make('Mira', ana)).character;
  for (const c of [brann, mira]) await ok('PATCH', `/api/characters/${c.id}`, { currency: { gp: 20 } }, gm);
  const gold = async (c) => (await ok('GET', `/api/characters/${c.id}`, null, gm)).character.currency.gp;
  const [brannGp, miraGp] = [await gold(brann), await gold(mira)];

  // Calendar and clock: GM only; players see the date.
  assert.equal((await call('PATCH', `/api/worlds/${world.id}/calendar`, { daysPerWeek: 10 }, pat)).status, 403);
  await ok('PATCH', `/api/worlds/${world.id}/calendar`, { daysPerWeek: 7, daysPerMonth: 28, monthsPerYear: 2, monthNames: ['Frost', 'Thaw'] }, gm);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/clock`, { advanceDays: 3 }, pat)).status, 403);
  assert.equal((await ok('POST', `/api/campaigns/${camp.id}/clock`, { advanceDays: 3 }, gm)).label, '4 Frost, Year 1');
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, pat)).clock.day, 3);
  assert.equal((await call('GET', `/api/campaigns/${camp.id}/downtime`, null, await user('Stranger'))).status, 404);

  // Three weeks of downtime with a custom paid activity and a unique-resource one.
  const acts = ['training', 'research', 'work', { key: 'forge', name: 'Rent the master forge', days: 4, resolution: 'manual', gpCost: 5, rewardItem: 'Masterwork blade' }];
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 3, unit: 'weeks', activities: acts }, pat)).status, 403);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 3, unit: 'weeks', activities: ['nope'] }, gm)).status, 400);
  const w = await ok('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 3, unit: 'weeks', activities: acts }, gm);
  assert.deepEqual([w.startDay, w.endDay], [3, 24]);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 1, activities: acts }, gm)).status, 409, 'one window at a time');
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/clock`, { advanceDays: 1 }, gm)).status, 409, 'no time jumps during downtime');

  const book = (tok, b) => call('POST', `/api/downtime/${w.id}/actions`, b, tok);
  // Players act independently, only for their own characters, only allowed activities, inside the window.
  assert.equal((await book(ana, { characterId: brann.id, activity: 'training', startDay: 3 })).status, 403);
  assert.equal((await book(viv, { characterId: brann.id, activity: 'training', startDay: 3 })).status, 403);
  assert.equal((await book(pat, { characterId: brann.id, activity: 'crafting', startDay: 3 })).status, 400);
  assert.equal((await book(pat, { characterId: brann.id, activity: 'training', startDay: 20 })).status, 409, 'runs past the end');
  const train = (await book(pat, { characterId: brann.id, activity: 'training', startDay: 3, details: 'Longsword drills' })).body;
  assert.equal(train.status, 'proposed');
  assert.equal((await book(pat, { characterId: brann.id, activity: 'work', startDay: 10 })).status, 409, 'overlaps training');
  const work = (await book(pat, { characterId: brann.id, activity: 'work', startDay: 13 })).body;
  assert.equal(work.status, 'approved', 'auto activities resolve at once');
  const research = (await book(ana, { characterId: mira.id, activity: 'research', startDay: 3 })).body;
  assert.equal(research.status, 'resolved');
  assert.equal(research.outcome.roll.dc, 12);
  assert.ok(/^1d20[+-]\d+$/.test(research.outcome.roll.formula), 'the check comes from the sheet');

  // Both want the master forge: both requests kept, flagged for the GM.
  const brannForge = (await book(pat, { characterId: brann.id, activity: 'forge', startDay: 20, claim: 'Master Forge' })).body;
  const miraForge = (await book(ana, { characterId: mira.id, activity: 'forge', startDay: 10, claim: 'master forge' })).body;
  assert.equal(miraForge.status, 'conflicted', JSON.stringify([brannForge, miraForge]));

  // Each player sees only their own activities.
  const anaView = await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, ana);
  assert.deepEqual(anaView.windows[0].actions.map((a) => a.characterName), ['Mira', 'Mira']);
  assert.equal(anaView.templates, undefined);
  const gmView = await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, gm);
  assert.equal(gmView.windows[0].actions.length, 5);
  assert.equal(gmView.windows[0].actions.find((a) => a.id === brannForge.id).status, 'conflicted');

  // Pause blocks new bookings; cannot shorten past booked activities.
  await ok('PATCH', `/api/downtime/${w.id}`, { status: 'paused' }, gm);
  assert.equal((await book(ana, { characterId: mira.id, activity: 'work', startDay: 17 })).status, 409);
  await ok('PATCH', `/api/downtime/${w.id}`, { status: 'open' }, gm);
  assert.equal((await call('PATCH', `/api/downtime/${w.id}`, { endDay: 15 }, gm)).status, 409);

  // Publishing with undecided activities needs an explicit choice.
  assert.equal((await call('POST', `/api/downtime/${w.id}/publish`, {}, gm)).status, 409);

  // GM decisions: manual needs an outcome; awarding the forge to Mira rejects Brann's claim.
  const decide = (a, b, tok = gm) => call('PATCH', `/api/downtime-actions/${a.id}`, b, tok);
  assert.equal((await decide(train, { status: 'approved' }, pat)).status, 403);
  assert.equal((await decide(train, { status: 'approved' })).status, 400);
  await ok('PATCH', `/api/downtime-actions/${train.id}`, { status: 'approved', outcome: { success: true, notes: 'Learns a new stance', rewardXp: 100 } }, gm);
  await ok('PATCH', `/api/downtime-actions/${miraForge.id}`, { status: 'approved', outcome: { success: true, rewardItem: 'Masterwork blade' } }, gm);
  const after = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, pat)).windows[0].actions.find((a) => a.id === brannForge.id);
  assert.equal(after.status, 'rejected');
  assert.match(after.gmNotes, /Mira/);
  await ok('PATCH', `/api/downtime-actions/${research.id}`, { status: 'proposed' }, gm); // postponed: still waiting

  // Publish: the postponed one is cancelled only because the GM said so.
  const pub = await ok('POST', `/api/downtime/${w.id}/publish`, { unresolved: 'cancel' }, gm);
  assert.equal(pub.status, 'published');
  assert.equal(pub.report.cancelled, 1);
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, pat)).clock.day, 24, 'clock moves to the end of downtime');
  assert.equal(await gold(brann), brannGp + 7, 'work wages');
  assert.equal(await gold(mira), miraGp - 5, 'forge rent');
  const miraSheet = await ok('GET', `/api/characters/${mira.id}`, null, ana);
  assert.equal(miraSheet.character.inventory.filter((i) => i.name === 'Masterwork blade').length, 1, 'the unique item exists once');
  assert.equal((await ok('GET', `/api/characters/${brann.id}`, null, pat)).xp, 100);

  // The report: each player sees their own lines; nothing can be published twice.
  const report = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, pat)).windows[0].report;
  assert.deepEqual(report.characters.map((r) => r.name), ['Brann']);
  assert.deepEqual(report.characters[0].timeline.map((x) => [x.activity, x.status]), [['Training', 'approved'], ['Working a trade', 'approved'], ['Rent the master forge', 'rejected']]);
  assert.equal((await call('POST', `/api/downtime/${w.id}/publish`, {}, gm)).status, 409);
  assert.equal((await call('PATCH', `/api/downtime-actions/${train.id}`, { status: 'approved', outcome: { rewardGp: 999 } }, gm)).status, 409);
  assert.equal((await book(pat, { characterId: brann.id, activity: 'work', startDay: 20 })).status, 409);
});

test('downtime: publishing refuses when a character cannot pay, and changes nothing', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'milestone' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const c = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Odo', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, gm)).character;
  await ok('PATCH', `/api/characters/${c.id}`, { currency: { gp: 10 } }, gm);
  const w = await ok('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 10, activities: [{ key: 'lab', name: 'Lab', days: 2, gpCost: 6 }] }, gm);
  const a = await ok('POST', `/api/downtime/${w.id}/actions`, { characterId: c.id, activity: 'lab', startDay: 0 }, gm);
  const b = await ok('POST', `/api/downtime/${w.id}/actions`, { characterId: c.id, activity: 'lab', startDay: 2 }, gm);
  for (const x of [a, b]) await ok('PATCH', `/api/downtime-actions/${x.id}`, { status: 'approved', outcome: { success: true } }, gm);
  assert.equal((await call('POST', `/api/downtime/${w.id}/publish`, {}, gm)).status, 409);
  assert.equal((await ok('GET', `/api/characters/${c.id}`, null, gm)).character.currency.gp, 10);
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, gm)).clock.day, 0);
  await ok('PATCH', `/api/downtime-actions/${b.id}`, { status: 'rejected' }, gm);
  await ok('POST', `/api/downtime/${w.id}/publish`, {}, gm);
  assert.equal((await ok('GET', `/api/characters/${c.id}`, null, gm)).character.currency.gp, 4);
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, gm)).clock.day, 10);
});
