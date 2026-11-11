// Milestone 5 chat: table, whisper, GM and audience channels delivered only to people allowed to read them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('chat channels, whispers, moderation and rate limit', async (t) => {
  const { call, ok, listenTo, close } = await boot();
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return close(); });
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const join = async (name, role = 'player') => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const [pat, ana, viv, out] = [await join('Pat'), await join('Ana'), await join('Viv', 'spectator'), await user('Out')];
  const ids = Object.fromEntries((await ok('GET', `/api/campaigns/${camp.id}/chat`, null, gm)).members.map((m) => [m.name, m.userId]));
  const say = (tok, b) => call('POST', `/api/campaigns/${camp.id}/chat`, b, tok);
  const path = `/api/campaigns/${camp.id}/chat/stream`;
  const [gL, pL, aL, vL] = await Promise.all([gm, pat, ana, viv].map((tok) => listenTo(path, tok)));
  streams.push(gL, pL, aL, vL);
  assert.equal((await listenTo(path, out)).status, 404);
  for (const s of [gL, pL, aL, vL]) assert.equal((await s.until(() => true)).event, 'snapshot');

  const table = (await say(pat, { channel: 'table', text: 'We go left.' })).body;
  for (const s of [gL, aL]) await s.until((m) => m.event === 'message' && m.data.id === table.id);
  const whisper = (await say(pat, { channel: 'whisper', toUserIds: [ids.Ana], text: 'I have the ring.' })).body;
  await aL.until((m) => m.data.id === whisper.id);
  await pL.until((m) => m.data.id === whisper.id);
  const gmNote = (await say(gm, { channel: 'gm', text: 'Ambush in 2 rounds.' })).body;
  await gL.until((m) => m.data.id === gmNote.id);
  const aud = (await say(viv, { channel: 'audience', text: 'Go left!' })).body;
  for (const s of [gL, pL, aL, vL]) await s.until((m) => m.data.id === aud.id);

  // Permissions.
  assert.equal((await say(viv, { channel: 'table', text: 'x' })).status, 403, 'spectators stay in the audience channel');
  assert.equal((await say(viv, { channel: 'whisper', toUserIds: [ids.Gm], text: 'x' })).status, 403);
  assert.equal((await say(pat, { channel: 'gm', text: 'x' })).status, 403);
  assert.equal((await say(pat, { channel: 'whisper', toUserIds: [ids.Viv], text: 'x' })).status, 400, 'no whispering to spectators');
  assert.equal((await say(pat, { channel: 'whisper', toUserIds: [], text: 'x' })).status, 400);
  assert.equal((await say(out, { channel: 'audience', text: 'x' })).status, 404);
  assert.equal((await say(pat, { channel: 'table', text: '' })).status, 400);

  // Nobody else ever received the whisper or the GM note.
  const leaked = (s, text) => JSON.stringify(s.msgs).includes(text);
  assert.ok(!leaked(gL, 'I have the ring') && !leaked(vL, 'I have the ring'), 'the GM does not read player whispers');
  assert.ok(![pL, aL, vL].some((s) => leaked(s, 'Ambush')));
  assert.ok(!leaked(vL, 'We go left'), 'table talk is not shown to the audience');
  const history = async (tok) => (await ok('GET', `/api/campaigns/${camp.id}/chat`, null, tok)).messages.map((m) => m.text);
  assert.deepEqual(await history(ana), ['We go left.', 'I have the ring.', 'Go left!']);
  assert.deepEqual(await history(viv), ['Go left!']);

  // Speaking as a character.
  const brann = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat)).character;
  assert.equal((await say(pat, { channel: 'table', text: 'For the clan!', characterId: brann.id })).body.asCharacter, 'Brann');
  assert.equal((await say(ana, { channel: 'table', text: 'Me too', characterId: brann.id })).status, 403);

  // Moderation.
  assert.equal((await call('DELETE', `/api/messages/${aud.id}`, null, pat)).status, 403);
  await ok('DELETE', `/api/messages/${aud.id}`, null, gm);
  await vL.until((m) => m.event === 'deleted' && m.data.id === aud.id);
  assert.deepEqual(await history(viv), []);

  // Rate limit: ten messages per ten seconds.
  let limited = 0;
  for (let i = 0; i < 12; i++) if ((await say(ana, { channel: 'table', text: `spam ${i}` })).status === 429) limited++;
  assert.equal(limited, 2, 'ten go through, the next two are refused');
});
