// Milestone 5: voice and video through a self-hosted LiveKit server (open-source WebRTC SFU; no AI features used).
// The app never carries media: it only mints short-lived LiveKit access tokens whose grants follow the campaign role,
// and asks LiveKit to change a participant's permissions when the GM mutes someone.
//
// Configuration (all three or voice is off):
//   LIVEKIT_URL         the URL browsers connect to, e.g. wss://voice.example.com (ws://localhost:7880 when testing)
//   LIVEKIT_API_KEY     key/secret pair from the LiveKit server's config
//   LIVEKIT_API_SECRET
//   LIVEKIT_API_URL     optional: how this server reaches LiveKit's HTTP API (default: LIVEKIT_URL with http/https)
'use strict';
const crypto = require('node:crypto');

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
// HS256 JWT, the format LiveKit access tokens use.
function signJwt(claims, secret) {
  const body = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
}

module.exports = function voice({ db, find, fail, need, record, check, env = process.env }) {
  const { bool, oneOf } = check;
  const cfg = env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET
    ? { url: env.LIVEKIT_URL, key: env.LIVEKIT_API_KEY, secret: env.LIVEKIT_API_SECRET,
      api: (env.LIVEKIT_API_URL || env.LIVEKIT_URL).replace(/^ws/, 'http').replace(/\/$/, '') }
    : null;
  const roomOf = (campaign) => `campaign-${campaign.id}`;
  const settings = (campaign) => campaign.voice || { spectators: 'none', muted: [] };

  function roleIn(user, campaign) {
    if (find('worlds', campaign.worldId).ownerId === user.id) return 'gm';
    const m = db.memberships.find((x) => x.userId === user.id && x.campaignId === campaign.id);
    return m ? m.role : 'none';
  }
  const token = (claims, ttl = 6 * 3600) => {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({ iss: cfg.key, nbf: now - 10, exp: now + ttl, ...claims }, cfg.secret);
  };
  // LiveKit's server API (Twirp over HTTP) with a short-lived room-admin token.
  async function roomService(method, body) {
    const res = await fetch(`${cfg.api}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token({ sub: 'living-quest', video: { room: body.room, roomAdmin: true, roomList: true } }, 60)}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(`LiveKit ${method}: ${res.status} ${await res.text()}`), { status: res.status });
    return res.json();
  }

  const routes = {
    'GET /api/campaigns/:id/voice': (u, _b, p) => {
      const campaign = find('campaigns', p.id);
      if (roleIn(u, campaign) === 'none') fail(404, 'campaign not found');
      return { enabled: !!cfg, ...settings(campaign) };
    },

    // Grants: GM and players publish microphone, camera and screen share; spectators only listen, hidden, and only if the GM allows it.
    'POST /api/campaigns/:id/voice/token': (u, _b, p) => {
      const campaign = find('campaigns', p.id);
      const role = roleIn(u, campaign);
      if (role === 'none') fail(404, 'campaign not found');
      if (!cfg) fail(503, 'voice and video are not configured on this server (set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)');
      const s = settings(campaign);
      if (role === 'spectator' && s.spectators !== 'listen') fail(403, 'the GM has not opened voice to spectators');
      const canPublish = role !== 'spectator' && !s.muted.includes(u.id);
      const room = roomOf(campaign);
      return {
        url: cfg.url, room, identity: u.id, role, canPublish,
        token: token({ sub: u.id, name: u.name, metadata: JSON.stringify({ role }),
          video: { room, roomJoin: true, canSubscribe: true, canPublish, canPublishData: false, hidden: role === 'spectator' } }),
      };
    },

    'PATCH /api/campaigns/:id/voice': (u, b, p) => {
      const campaign = find('campaigns', p.id);
      need(u, campaign.worldId, 'gm');
      campaign.voice = { ...settings(campaign), spectators: oneOf(b.spectators, ['none', 'listen'], 'spectators') };
      record(u.id, 'voice.settings', { campaignId: campaign.id, spectators: campaign.voice.spectators });
      return campaign.voice;
    },

    // GM mute: the participant loses the right to publish, now (if connected) and on every later join, until unmuted.
    'POST /api/campaigns/:id/voice/mute': async (u, b, p) => {
      const campaign = find('campaigns', p.id);
      need(u, campaign.worldId, 'gm');
      const target = find('users', b.userId);
      if (roleIn(target, campaign) !== 'player') fail(400, 'only players can be muted');
      const muted = bool(b.muted, 'muted');
      const s = settings(campaign);
      let live = false;
      if (cfg) {
        // Only touch a live participant: for an empty or unknown room LiveKit stalls and answers 503, not 404.
        const room = roomOf(campaign);
        const { rooms = [] } = await roomService('ListRooms', { room, names: [room] });
        const { participants = [] } = rooms.length ? await roomService('ListParticipants', { room }) : {};
        if (participants.some((x) => x.identity === target.id)) {
          await roomService('UpdateParticipant', { room, identity: target.id, permission: { canPublish: !muted, canSubscribe: true, canPublishData: false } });
          live = true;
        }
      }
      // Stored only after LiveKit accepted it (or the player was not connected), so a failed call changes nothing.
      campaign.voice = { ...s, muted: muted ? [...new Set([...s.muted, target.id])] : s.muted.filter((x) => x !== target.id) };
      record(u.id, 'voice.mute', { campaignId: campaign.id, userId: target.id, muted });
      return { ...campaign.voice, appliedLive: live };
    },
  };

  return { routes, signJwt, configured: !!cfg };
};
