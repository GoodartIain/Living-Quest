// Milestone 7: broadcast for livestreams. The GM turns it on per campaign and gets a secret link for an OBS browser
// source. The page shows the on-air scene exactly as a spectator of that campaign would see it — the same server
// projection, so hidden tokens, fog, private rolls, notes and whispers never reach the stream.
'use strict';
const crypto = require('node:crypto');

const DEFAULTS = { enabled: false, keyHash: null, sceneId: null, title: '', showInitiative: true, showRolls: true };

module.exports = function broadcast({ db, find, fail, need, record, check, hash, sceneView }) {
  const { str, bool } = check;
  const subscribers = new Set(); // { res, campaignId }
  const settings = (c) => ({ ...DEFAULTS, ...c.broadcast });
  const publicSettings = (c) => { const { keyHash, ...rest } = settings(c); return { ...rest, hasKey: !!keyHash }; };

  // What the stream shows: viewed as a spectator of this campaign (spectators see only `public` content).
  function state(c) {
    const s = settings(c);
    const out = { campaign: c.name, title: s.title, onAir: s.enabled, scene: null };
    const scene = s.sceneId && db.scenes.find((x) => x.id === s.sceneId);
    if (!scene) return out;
    try {
      const v = sceneView({ id: `broadcast:${c.id}`, broadcast: c.id }, scene);
      out.scene = { ...v, encounter: s.showInitiative ? v.encounter : null, rolls: s.showRolls ? v.rolls.slice(0, 8) : [] };
    } catch {
      out.notPublic = true; // the on-air scene is not public, so nothing of it is shown
    }
    return out;
  }
  const send = (res, data) => res.write(`event: state\ndata: ${JSON.stringify(data)}\n\n`);
  function publishCampaign(campaignId) {
    const c = find('campaigns', campaignId);
    for (const s of subscribers) if (s.campaignId === campaignId) send(s.res, state(c));
  }
  // Called whenever a scene changes (tokens, fog, encounter, rolls, character HP/conditions).
  function onScene(sceneId) {
    for (const c of new Set([...subscribers].map((s) => s.campaignId))) {
      if (settings(find('campaigns', c)).sceneId === sceneId) publishCampaign(c);
    }
  }
  function stop(campaignId) {
    for (const s of subscribers) if (s.campaignId === campaignId) { s.res.end('event: off\ndata: {}\n\n'); subscribers.delete(s); }
  }

  const routes = {
    'GET /api/campaigns/:id/broadcast': (u, _b, p) => {
      const c = find('campaigns', p.id);
      need(u, c.worldId, 'gm');
      return publicSettings(c);
    },
    // { enabled?, sceneId?, title?, showInitiative?, showRolls?, rotateKey? }. A new key is returned once, as `key`.
    'PATCH /api/campaigns/:id/broadcast': (u, b, p) => {
      const c = find('campaigns', p.id);
      need(u, c.worldId, 'gm');
      const s = settings(c);
      if (b.enabled !== undefined) s.enabled = bool(b.enabled, 'enabled');
      if (b.sceneId !== undefined) {
        if (b.sceneId !== null && find('scenes', b.sceneId).worldId !== c.worldId) fail(400, 'scene belongs to another world');
        s.sceneId = b.sceneId;
      }
      if (b.title !== undefined) s.title = b.title === '' ? '' : str(b.title, 'title', 120);
      if (b.showInitiative !== undefined) s.showInitiative = bool(b.showInitiative, 'showInitiative');
      if (b.showRolls !== undefined) s.showRolls = bool(b.showRolls, 'showRolls');
      let key = null;
      if (b.rotateKey === true || (s.enabled && !s.keyHash)) {
        key = crypto.randomBytes(24).toString('base64url');
        s.keyHash = hash(key);
      }
      c.broadcast = s;
      record(u.id, 'broadcast.updated', { campaignId: c.id, enabled: s.enabled, sceneId: s.sceneId, rotated: !!key });
      if (!s.enabled || key) stop(c.id); // switching off (or a new link) cuts every open stream at once
      else publishCampaign(c.id);
      return { ...publicSettings(c), ...(key && { key }) };
    },
  };

  // GET /api/broadcast/stream?key=… — no sign-in (OBS cannot sign in); the key is the credential.
  function stream(req, res, key) {
    const h = key && hash(key);
    const c = h && db.campaigns.find((x) => x.broadcast && x.broadcast.enabled && x.broadcast.keyHash === h);
    if (!c) fail(404, 'no broadcast with this link is on air');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    send(res, state(c));
    const sub = { res, campaignId: c.id };
    subscribers.add(sub);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); subscribers.delete(sub); });
  }

  return { routes, stream, onScene, subscribers };
};
