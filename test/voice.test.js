// Milestone 5 voice/video: LiveKit tokens with role-based grants, spectator access, GM mute.
// With LIVEKIT_TEST_URL (a LiveKit server running with the dev keys devkey/secret) the tokens are also checked against it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { boot } = require('./helpers.js');

const LK = process.env.LIVEKIT_TEST_URL;
const env = { LIVEKIT_URL: LK || 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' };
function verify(jwt, secret) {
  const [h, p, sig] = jwt.split('.');
  assert.equal(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url'), sig, 'signature');
  return JSON.parse(Buffer.from(p, 'base64url'));
}

async function campaign(env) {
  const t = await boot({ env });
  const user = async (name) => (await t.ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await t.ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await t.ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const join = async (name, role = 'player') => {
    const tok = await user(name);
    await t.ok('POST', `/api/invites/${(await t.ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  return { ...t, gm, camp, pat: await join('Pat'), viv: await join('Viv', 'spectator'), out: await user('Out') };
}

test('voice is off until LiveKit is configured', async (t) => {
  const c = await campaign({});
  t.after(c.close);
  assert.equal((await c.call('POST', `/api/campaigns/${c.camp.id}/voice/token`, null, c.pat)).status, 503);
  assert.equal((await c.ok('GET', `/api/campaigns/${c.camp.id}/voice`, null, c.pat)).enabled, false);
});

test('LiveKit tokens follow campaign roles; GM controls spectators and mutes', async (t) => {
  const c = await campaign(env);
  t.after(c.close);
  const tokenFor = (tok) => c.call('POST', `/api/campaigns/${c.camp.id}/voice/token`, null, tok);
  const gmT = (await tokenFor(c.gm)).body;
  const g = verify(gmT.token, 'secret');
  assert.deepEqual([g.iss, g.name, g.video.room, g.video.roomJoin, g.video.canPublish, g.video.canPublishData, g.video.hidden], ['devkey', 'Gm', `campaign-${c.camp.id}`, true, true, false, false]);
  assert.ok(g.exp - g.nbf <= 6 * 3600 + 10);
  const patT = (await tokenFor(c.pat)).body;
  assert.equal(verify(patT.token, 'secret').video.canPublish, true);
  assert.equal(patT.url, env.LIVEKIT_URL);
  assert.equal((await tokenFor(c.out)).status, 404);
  assert.equal((await tokenFor(c.viv)).status, 403, 'spectators are kept out by default');
  assert.equal((await c.call('PATCH', `/api/campaigns/${c.camp.id}/voice`, { spectators: 'listen' }, c.pat)).status, 403);
  await c.ok('PATCH', `/api/campaigns/${c.camp.id}/voice`, { spectators: 'listen' }, c.gm);
  const v = verify((await tokenFor(c.viv)).body.token, 'secret').video;
  assert.deepEqual([v.canPublish, v.canSubscribe, v.hidden], [false, true, true], 'listen-only and invisible');

  const patId = verify(patT.token, 'secret').sub;
  const mute = (muted, tok = c.gm) => c.call('POST', `/api/campaigns/${c.camp.id}/voice/mute`, { userId: patId, muted }, tok);
  assert.equal((await mute(true, c.pat)).status, 403);
  const m = await mute(true);
  assert.deepEqual(m.body.muted, [patId]);
  if (LK) assert.equal(m.body.appliedLive, false, 'Pat is not in the call, so the stored mute waits for the next join');
  assert.equal(verify((await tokenFor(c.pat)).body.token, 'secret').video.canPublish, false, 'a muted player rejoins muted');
  await mute(false);
  assert.equal(verify((await tokenFor(c.pat)).body.token, 'secret').video.canPublish, true);
});

test('a real LiveKit server accepts the tokens', { skip: !LK && 'set LIVEKIT_TEST_URL to a LiveKit dev server' }, async () => {
  const voice = require('../voice.js');
  const { signJwt } = voice({ db: {}, find() {}, fail() {}, need() {}, record() {}, check: {}, env: {} });
  const now = Math.floor(Date.now() / 1000);
  const admin = signJwt({ iss: 'devkey', sub: 'test', nbf: now - 10, exp: now + 60, video: { roomList: true } }, 'secret');
  const ok = await fetch(`${LK.replace(/^ws/, 'http')}/twirp/livekit.RoomService/ListRooms`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` }, body: '{}' });
  assert.equal(ok.status, 200);
  const forged = signJwt({ iss: 'devkey', sub: 'test', nbf: now - 10, exp: now + 60, video: { roomList: true } }, 'wrong-secret');
  const no = await fetch(`${LK.replace(/^ws/, 'http')}/twirp/livekit.RoomService/ListRooms`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${forged}` }, body: '{}' });
  assert.equal(no.status, 401);
});
