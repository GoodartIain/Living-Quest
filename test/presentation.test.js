// Milestone 12 acceptance: a GM broadcasts a public-safe presentation with selected scenes and overlays, while
// retaining private GM controls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('presentation: playlist, cameras, overlays, consent, polls, reactions, delay, private controls', async (t) => {
  const { call, ok, listenTo, close } = await boot();
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return close(); });
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven Live' }, gm);
  const join = async (name, role = 'player') => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const [pat, ana, viv] = [await join('Pat'), await join('Ana'), await join('Viv', 'spectator')];
  const hero = (name, tok) => ok('POST', `/api/campaigns/${camp.id}/characters`, { name, species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, tok);
  const brann = (await hero('Brann', pat)).character;
  const mira = (await hero('Mira', ana)).character;
  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 1, y: 1, visibility: 'public' }, gm);
  const tavern = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Tavern', visibility: 'public', cols: 10, rows: 8 }, gm);
  const market = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', visibility: 'public' }, gm);
  const crypt = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'SECRET-crypt', visibility: 'gm' }, gm);
  const herald = await ok('POST', `/api/scenes/${tavern.id}/tokens`, { name: 'Herald', x: 1, y: 1, visibility: 'public' }, gm);
  const goblin = await ok('POST', `/api/scenes/${tavern.id}/tokens`, { name: 'SECRET-goblin', x: 2, y: 2, visibility: 'gm' }, gm);
  await ok('POST', `/api/scenes/${tavern.id}/tokens`, { name: 'SECRET-partytoken', x: 3, y: 3, visibility: 'party' }, gm);
  await ok('PATCH', `/api/campaigns/${camp.id}/director`, { notes: 'SECRET-notes' }, gm);

  // Private GM controls: nobody else can touch or even read them.
  const bc = (b, tok = gm) => call('PATCH', `/api/campaigns/${camp.id}/broadcast`, b, tok);
  for (const tok of [pat, viv]) {
    assert.equal((await bc({ enabled: true }, tok)).status, 403);
    assert.equal((await call('GET', `/api/campaigns/${camp.id}/broadcast/preview`, null, tok)).status, 403);
    assert.equal((await call('POST', `/api/campaigns/${camp.id}/highlights`, {}, tok)).status, 403);
    assert.equal((await call('POST', `/api/campaigns/${camp.id}/poll`, { question: 'q', options: ['a', 'b'] }, tok)).status, 403);
  }
  assert.equal((await bc({ camera: 'drone' })).status, 400);
  assert.equal((await bc({ branding: { imageUrl: 'javascript:alert(1)' } })).status, 400);

  // Go on air with a playlist, overlays and the party panel.
  const on = (await bc({ enabled: true, playlist: [tavern.id, market.id, crypt.id], sceneId: tavern.id, title: 'Live from Greyhaven',
    lowerThird: 'Session 12: The Herald\'s News', branding: { text: 'Sponsored by the Dice Tower Inn' }, accent: '#3366cc', showParty: 'health' })).body;
  assert.ok(on.key);
  const tv = await listenTo('/api/broadcast/stream', on.key, 'key');
  streams.push(tv);
  let s = (await tv.until((m) => m.event === 'state' && m.data.scene)).data;
  assert.deepEqual(s.scene.tokens.map((x) => x.name), ['Herald']);
  assert.deepEqual([s.lowerThird, s.branding.text, s.accent, s.title], ['Session 12: The Herald\'s News', 'Sponsored by the Dice Tower Inn', '#3366cc', 'Live from Greyhaven']);
  assert.deepEqual(s.party, [], 'no player has agreed to be shown yet');

  // Consent is the player's: the GM cannot opt a character in.
  assert.equal((await call('PATCH', `/api/characters/${brann.id}`, { onStream: true }, gm)).status, 403);
  await ok('PATCH', `/api/characters/${brann.id}`, { onStream: true }, pat);
  await bc({ showParty: 'health' }); // a settings change republishes
  s = (await tv.until((m) => m.event === 'state' && m.data.party.length === 1)).data;
  assert.equal(s.party[0].name, 'Brann');
  assert.equal(s.party[0].hp.max, 13);
  assert.ok(!s.party.some((x) => x.name === 'Mira'), 'Mira\'s player has not agreed');
  await bc({ showParty: 'names' });
  s = (await tv.until((m) => m.event === 'state' && m.data.party.length === 1 && !m.data.party[0].hp)).data;
  assert.equal(s.party[0].hp, undefined, 'names only: no health');
  assert.ok(mira);

  // Cameras: following a hidden token falls back to tactical; a visible one is followed.
  await bc({ camera: 'follow', followTokenId: goblin.id });
  s = (await tv.until((m) => m.event === 'state' && m.data.camera === 'tactical')).data;
  assert.equal(s.followTokenId, null);
  await bc({ followTokenId: herald.id });
  s = (await tv.until((m) => m.event === 'state' && m.data.camera === 'follow')).data;
  assert.equal(s.followTokenId, herald.id);
  await bc({ camera: 'cinematic' });
  await tv.until((m) => m.event === 'state' && m.data.camera === 'cinematic');

  // Selected scenes: take the market, then the GM-only crypt (shows nothing of it), then a title card (no scene at all).
  await bc({ sceneId: market.id });
  await tv.until((m) => m.event === 'state' && m.data.scene && m.data.scene.scene.name === 'Market');
  await bc({ sceneId: crypt.id });
  s = (await tv.until((m) => m.event === 'state' && m.data.notPublic)).data;
  assert.equal(s.scene, null);
  await bc({ sceneId: tavern.id, card: { kind: 'break' } });
  s = (await tv.until((m) => m.event === 'state' && m.data.card)).data;
  assert.deepEqual([s.card.text, s.scene], ['Be right back', null], 'a title card hides the scene');
  await bc({ card: null });
  await tv.until((m) => m.event === 'state' && !m.data.card && m.data.scene && m.data.scene.scene.name === 'Tavern');

  // The GM's preview is exactly what the stream shows.
  const preview = await ok('GET', `/api/campaigns/${camp.id}/broadcast/preview`, null, gm);
  assert.deepEqual(preview, tv.msgs.filter((m) => m.event === 'state').at(-1).data);

  // Audience poll: players and spectators vote once; the GM does not; the stream shows counts, never who.
  await ok('POST', `/api/campaigns/${camp.id}/poll`, { question: 'Where next?', options: ['The crypt', 'The docks'] }, gm);
  const ids = Object.fromEntries((await ok('GET', `/api/worlds/${world.id}`, null, gm)).members.map((m) => [m.name, m.userId]));
  await ok('POST', `/api/campaigns/${camp.id}/poll/vote`, { option: 1 }, viv);
  await ok('POST', `/api/campaigns/${camp.id}/poll/vote`, { option: 1 }, pat);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/poll/vote`, { option: 0 }, viv)).status, 409);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/poll/vote`, { option: 0 }, gm)).status, 403);
  s = (await tv.until((m) => m.event === 'state' && m.data.poll && m.data.poll.total === 2)).data;
  assert.deepEqual(s.poll.options.map((o) => o.votes), [0, 2]);
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/audience`, null, viv)).poll.mine, 1);
  await ok('PATCH', `/api/campaigns/${camp.id}/poll`, { open: false }, gm);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/poll/vote`, { option: 0 }, ana)).status, 409);

  // Reactions: off until the GM allows them; anonymous; rate-limited.
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/react`, { emoji: '🔥' }, viv)).status, 409);
  await bc({ reactions: true });
  await ok('POST', `/api/campaigns/${camp.id}/react`, { emoji: '🔥' }, viv);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/react`, { emoji: '🔥' }, viv)).status, 429);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/react`, { emoji: '<script>' }, pat)).status, 400);
  assert.deepEqual((await tv.until((m) => m.event === 'reaction')).data, { emoji: '🔥' });

  // Highlights: GM-only markers, never on stream.
  await ok('POST', `/api/campaigns/${camp.id}/highlights`, { note: 'SECRET-highlight: the herald lies' }, gm);
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/broadcast`, null, gm)).highlights.length, 1);
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/broadcast`, null, gm)).viewers, 1);

  // Stream delay: changes reach the stream only after the delay; a new viewer sees what has aired, not the live state.
  await bc({ delaySeconds: 1 });
  await wait(1100);
  const n = tv.msgs.length;
  await ok('PATCH', `/api/tokens/${herald.id}`, { x: 6, y: 5 }, gm);
  await wait(400);
  const heraldAt6 = (m) => m.event === 'state' && m.data.scene && m.data.scene.tokens.some((x) => x.name === 'Herald' && x.x === 6);
  assert.ok(!tv.msgs.slice(n).some(heraldAt6), 'not yet');
  const late = await listenTo('/api/broadcast/stream', on.key, 'key');
  streams.push(late);
  const first = (await late.until((m) => m.event === 'state')).data;
  assert.ok(!heraldAt6({ event: 'state', data: first }), 'a new viewer does not see past the delay');
  await tv.until(heraldAt6, 2000);

  // Nothing secret ever reached the stream.
  const all = JSON.stringify([...tv.msgs, ...late.msgs]);
  assert.deepEqual([...new Set(all.match(/SECRET-[a-z]+/g) || [])], []);
  for (const uid of Object.values(ids)) assert.ok(!all.includes(uid), 'no user ids on stream');

  // Off is immediate, whatever the delay.
  await bc({ enabled: false });
  await tv.until((m) => m.event === 'off', 500);

  // A GM who stops the stream over a mistake, fixes it and goes back on air never airs the mistake late.
  await bc({ enabled: true });
  const watching = await listenTo('/api/broadcast/stream', on.key, 'key');
  streams.push(watching);
  await ok('PATCH', `/api/tokens/${goblin.id}`, { visibility: 'public' }, gm); // oops: queued for 1 s
  await bc({ enabled: false });
  await watching.until((m) => m.event === 'off', 500);
  await ok('PATCH', `/api/tokens/${goblin.id}`, { visibility: 'gm' }, gm);
  await bc({ enabled: true });
  const again = await listenTo('/api/broadcast/stream', on.key, 'key');
  streams.push(again);
  await wait(1500);
  assert.ok(!JSON.stringify([...again.msgs, ...watching.msgs]).includes('SECRET-goblin'), 'the queued frame was dropped when the stream stopped');
  assert.ok(again.msgs.some((m) => m.event === 'state' && m.data.scene), 'the corrected scene airs');
});
