// Milestones 7 and 12: broadcast for livestreams. The GM turns it on per campaign and gets a secret link for an OBS
// browser source. The page shows the on-air scene exactly as a spectator of that campaign would see it — the same server
// projection, so hidden tokens, fog, private rolls, notes and whispers never reach the stream. Milestone 12 adds a scene
// playlist, GM-directed cameras, overlays (title cards, lower third, branding, party panel with player consent), audience
// polls and reactions, a stream delay, highlight markers and a viewer count. Every overlay is built on the server.
'use strict';
const crypto = require('node:crypto');

const DEFAULTS = { enabled: false, keyHash: null, sceneId: null, title: '', showInitiative: true, showRolls: true,
  playlist: [], camera: 'board', followTokenId: null, card: null, lowerThird: '', branding: { text: '', imageUrl: '' }, accent: '#e0a66a',
  showParty: 'off', delaySeconds: 0, reactions: false, poll: null, highlights: [] };
const CAMERAS = ['board', 'tactical', 'cinematic', 'follow'];
const CARDS = { starting: 'Starting soon', break: 'Be right back', ending: 'Thanks for watching' };
const EMOJI = ['👏', '😂', '😱', '🎲', '❤️', '🔥'];

module.exports = function broadcast({ db, find, fail, need, record, id, check, hash, sceneView, tokenInfo }) {
  const { str, bool, num, oneOf, safeUrl } = check;
  const subscribers = new Set(); // { res, campaignId }
  const aired = new Map();        // campaignId → last state sent to the stream (what a new viewer sees under a delay)
  const timers = new Map();       // campaignId → pending delayed sends
  const lastReaction = new Map(); // userId → ms, a simple rate limit
  const settings = (c) => ({ ...DEFAULTS, ...c.broadcast });
  const publicSettings = (c) => { const { keyHash, ...rest } = settings(c); return { ...rest, hasKey: !!keyHash, viewers: [...subscribers].filter((s) => s.campaignId === c.id).length }; };

  // What the stream shows: viewed as a spectator of this campaign (spectators see only `public` content).
  function state(c) {
    const s = settings(c);
    const out = { campaign: c.name, title: s.title, onAir: s.enabled, scene: null, camera: s.camera, followTokenId: null, card: null,
      lowerThird: s.lowerThird, branding: s.branding, accent: s.accent, party: [], poll: pollView(s.poll) };
    if (s.card) { out.card = { kind: s.card.kind, text: s.card.text || CARDS[s.card.kind] || '' }; return out; } // a title card hides the scene entirely
    const scene = s.sceneId && db.scenes.find((x) => x.id === s.sceneId);
    if (scene) {
      try {
        const v = sceneView({ id: `broadcast:${c.id}`, broadcast: c.id }, scene);
        out.scene = { ...v, encounter: s.showInitiative ? v.encounter : null, rolls: s.showRolls ? v.rolls.slice(0, 8) : [], triggers: [] };
        // Follow only a token the audience can see; otherwise the tactical camera.
        if (s.camera === 'follow') out.followTokenId = v.tokens.some((t) => t.id === s.followTokenId) ? s.followTokenId : null;
        if (s.camera === 'follow' && !out.followTokenId) out.camera = 'tactical';
      } catch {
        out.notPublic = true; // the on-air scene is not public, so nothing of it is shown
      }
    }
    // Party panel: only characters whose player agreed to be shown on stream; HP only if the GM allows it.
    if (s.showParty !== 'off') {
      out.party = db.characters.filter((ch) => ch.campaignId === c.id && ch.onStream).map((ch) => {
        const info = tokenInfo(ch.id, s.showParty === 'health');
        return { name: ch.name, portraitUrl: ch.portraitUrl || '', className: ch.className, level: info.level, ...(info.hp && { hp: info.hp }) };
      });
    }
    return out;
  }
  function pollView(p) {
    if (!p) return null;
    const counts = p.options.map((_, i) => Object.values(p.votes).filter((v) => v === i).length);
    return { id: p.id, question: p.question, options: p.options.map((text, i) => ({ text, votes: counts[i] })), open: p.open, total: Object.keys(p.votes).length };
  }

  const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Everything the stream receives goes through here, so the delay applies to scenes, polls and reactions alike.
  function air(c, event, data) {
    const delay = settings(c).delaySeconds * 1000;
    const send = () => {
      if (event === 'state') aired.set(c.id, data);
      for (const s of subscribers) if (s.campaignId === c.id) write(s.res, event, data);
    };
    if (!delay) return send();
    const t = setTimeout(() => { (timers.get(c.id) || new Set()).delete(t); send(); }, delay);
    if (!timers.has(c.id)) timers.set(c.id, new Set());
    timers.get(c.id).add(t);
  }
  const publishCampaign = (campaignId) => { const c = find('campaigns', campaignId); air(c, 'state', state(c)); };
  // Called whenever a scene changes (tokens, fog, encounter, rolls, character HP/conditions).
  function onScene(sceneId) {
    for (const cid of new Set([...subscribers].map((s) => s.campaignId))) {
      if (settings(find('campaigns', cid)).sceneId === sceneId) publishCampaign(cid);
    }
  }
  function stop(campaignId) { // immediate, whatever the delay
    for (const t of timers.get(campaignId) || []) clearTimeout(t);
    timers.delete(campaignId);
    aired.delete(campaignId);
    for (const s of subscribers) if (s.campaignId === campaignId) { s.res.end('event: off\ndata: {}\n\n'); subscribers.delete(s); }
  }

  const gmCampaign = (u, cid) => { const c = find('campaigns', cid); need(u, c.worldId, 'gm'); return c; };
  const sceneIn = (c, sid) => { if (find('scenes', sid).worldId !== c.worldId) fail(400, 'scene belongs to another world'); return sid; };
  const audience = (u, c) => { const role = need(u, c.worldId, 'spectator'); if (role === 'gm') fail(403, 'the GM runs polls, not votes in them'); return role; };

  const routes = {
    'GET /api/campaigns/:id/broadcast': (u, _b, p) => publicSettings(gmCampaign(u, p.id)),
    // Exactly what the stream shows right now (GM's preview), from the same projection.
    'GET /api/campaigns/:id/broadcast/preview': (u, _b, p) => state(gmCampaign(u, p.id)),
    // { enabled?, sceneId?, title?, showInitiative?, showRolls?, rotateKey?, playlist?, camera?, followTokenId?, card?, lowerThird?,
    //   branding?, accent?, showParty?, delaySeconds?, reactions? }. A new key is returned once, as `key`.
    'PATCH /api/campaigns/:id/broadcast': (u, b, p) => {
      const c = gmCampaign(u, p.id);
      const s = settings(c);
      if (b.enabled !== undefined) s.enabled = bool(b.enabled, 'enabled');
      if (b.playlist !== undefined) {
        if (!Array.isArray(b.playlist) || b.playlist.length > 30) fail(400, 'playlist: up to 30 scenes');
        s.playlist = [...new Set(b.playlist.map((x) => sceneIn(c, x)))];
      }
      if (b.sceneId !== undefined) s.sceneId = b.sceneId === null ? null : sceneIn(c, b.sceneId);
      if (b.title !== undefined) s.title = b.title === '' ? '' : str(b.title, 'title', 120);
      if (b.showInitiative !== undefined) s.showInitiative = bool(b.showInitiative, 'showInitiative');
      if (b.showRolls !== undefined) s.showRolls = bool(b.showRolls, 'showRolls');
      if (b.camera !== undefined) s.camera = oneOf(b.camera, CAMERAS, 'camera');
      if (b.followTokenId !== undefined) {
        if (b.followTokenId !== null && find('tokens', b.followTokenId).worldId !== c.worldId) fail(400, 'token belongs to another world');
        s.followTokenId = b.followTokenId;
      }
      if (b.card !== undefined) s.card = b.card === null ? null : { kind: oneOf(b.card.kind, [...Object.keys(CARDS), 'custom'], 'card'), text: b.card.text ? str(b.card.text, 'card text', 200) : '' };
      if (b.lowerThird !== undefined) s.lowerThird = b.lowerThird === '' ? '' : str(b.lowerThird, 'lowerThird', 160);
      if (b.branding !== undefined) s.branding = { text: b.branding.text ? str(b.branding.text, 'branding text', 80) : '', imageUrl: b.branding.imageUrl ? safeUrl(b.branding.imageUrl) : '' };
      if (b.accent !== undefined) s.accent = /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : fail(400, 'accent must be #rrggbb');
      if (b.showParty !== undefined) s.showParty = oneOf(b.showParty, ['off', 'names', 'health'], 'showParty');
      if (b.delaySeconds !== undefined) s.delaySeconds = num(b.delaySeconds, 'delaySeconds', 0, 120, true);
      if (b.reactions !== undefined) s.reactions = bool(b.reactions, 'reactions');
      let key = null;
      if (b.rotateKey === true || (s.enabled && !s.keyHash)) {
        key = crypto.randomBytes(24).toString('base64url');
        s.keyHash = hash(key);
      }
      c.broadcast = s;
      record(u.id, 'broadcast.updated', { campaignId: c.id, fields: Object.keys(b).filter((k) => k !== 'rotateKey'), rotated: !!key });
      if (!s.enabled || key) stop(c.id); // switching off (or a new link) cuts every open stream at once
      else publishCampaign(c.id);
      return { ...publicSettings(c), ...(key && { key }) };
    },
    'POST /api/campaigns/:id/highlights': (u, b, p) => {
      const c = gmCampaign(u, p.id);
      const s = settings(c);
      const h = { id: id(), at: new Date().toISOString(), day: c.clock.day, minute: c.clock.minute, note: b.note ? str(b.note, 'note', 200) : '', sceneId: s.sceneId };
      c.broadcast = { ...s, highlights: [...s.highlights.slice(-199), h] };
      record(u.id, 'broadcast.highlight', { campaignId: c.id, highlightId: h.id });
      return h;
    },

    // Polls: the GM asks, the audience (players and spectators) answers once; results never change gameplay.
    'POST /api/campaigns/:id/poll': (u, b, p) => {
      const c = gmCampaign(u, p.id);
      if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 6) fail(400, 'options: 2 to 6');
      c.broadcast = { ...settings(c), poll: { id: id(), question: str(b.question, 'question', 160), options: b.options.map((o) => str(o, 'option', 80)), open: true, votes: {} } };
      record(u.id, 'poll.opened', { campaignId: c.id });
      publishCampaign(c.id);
      return pollView(c.broadcast.poll);
    },
    'PATCH /api/campaigns/:id/poll': (u, b, p) => { // { open: false } closes it; { clear: true } removes it from the stream
      const c = gmCampaign(u, p.id);
      const s = settings(c);
      if (!s.poll) fail(404, 'no poll');
      c.broadcast = { ...s, poll: b.clear === true ? null : { ...s.poll, open: b.open === undefined ? s.poll.open : bool(b.open, 'open') } };
      record(u.id, 'poll.updated', { campaignId: c.id, clear: b.clear === true });
      publishCampaign(c.id);
      return pollView(c.broadcast.poll);
    },
    // Audience view: the poll (counts and your own vote) and whether reactions are on.
    'GET /api/campaigns/:id/audience': (u, _b, p) => {
      const c = find('campaigns', p.id);
      const role = need(u, c.worldId, 'spectator');
      const s = settings(c);
      return { live: s.enabled, reactions: s.enabled && s.reactions, emoji: EMOJI, poll: s.poll && { ...pollView(s.poll), mine: role === 'gm' ? null : s.poll.votes[u.id] ?? null } };
    },
    'POST /api/campaigns/:id/poll/vote': (u, b, p) => {
      const c = find('campaigns', p.id);
      audience(u, c);
      const s = settings(c);
      if (!s.poll || !s.poll.open) fail(409, 'no open poll');
      if (s.poll.votes[u.id] !== undefined) fail(409, 'you have already voted');
      const i = num(b.option, 'option', 0, s.poll.options.length - 1, true);
      c.broadcast = { ...s, poll: { ...s.poll, votes: { ...s.poll.votes, [u.id]: i } } };
      publishCampaign(c.id);
      return pollView(c.broadcast.poll);
    },
    'POST /api/campaigns/:id/react': (u, b, p) => {
      const c = find('campaigns', p.id);
      audience(u, c);
      const s = settings(c);
      if (!s.enabled || !s.reactions) fail(409, 'reactions are off');
      const emoji = oneOf(b.emoji, EMOJI, 'emoji');
      const now = Date.now();
      if (now - (lastReaction.get(u.id) || 0) < 2000) fail(429, 'one reaction every 2 seconds');
      lastReaction.set(u.id, now);
      air(c, 'reaction', { emoji }); // anonymous on stream
      return { ok: true };
    },
  };

  // GET /api/broadcast/stream?key=… — no sign-in (OBS cannot sign in); the key is the credential.
  function stream(req, res, key) {
    const h = key && hash(key);
    const c = h && db.campaigns.find((x) => x.broadcast && x.broadcast.enabled && x.broadcast.keyHash === h);
    if (!c) fail(404, 'no broadcast with this link is on air');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // Under a delay, a new viewer gets what has already aired, never the live state.
    const first = settings(c).delaySeconds ? aired.get(c.id) : state(c);
    if (first) write(res, 'state', first);
    else write(res, 'state', { campaign: c.name, title: settings(c).title, onAir: true, scene: null, card: { kind: 'starting', text: 'Starting soon' }, party: [], poll: null });
    const sub = { res, campaignId: c.id };
    subscribers.add(sub);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); subscribers.delete(sub); });
  }

  return { routes, stream, onScene, subscribers };
};
