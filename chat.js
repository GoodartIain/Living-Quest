// Milestone 5: campaign chat. Channels: table (GM + players), whisper (sender + recipients only), gm (GMs only),
// audience (spectators, players and GM). Every message is delivered only to people allowed to read it.
'use strict';

const CHANNELS = ['table', 'whisper', 'gm', 'audience'];
const RATE = { count: 10, windowMs: 10000 }; // per user: 10 messages per 10 seconds

module.exports = function chat({ db, find, fail, need, record, id, check, characterOwner }) {
  const { str, oneOf } = check;
  const subscribers = new Set(); // { res, user, campaignId }
  const recent = new Map(); // userId -> timestamps, for the rate limit

  // The user's role in this campaign: the world owner is GM; otherwise their membership of this campaign.
  function roleIn(user, campaign) {
    if (find('worlds', campaign.worldId).ownerId === user.id) return 'gm';
    const m = db.memberships.find((x) => x.userId === user.id && x.campaignId === campaign.id);
    return m ? m.role : 'none';
  }
  function canRead(user, role, m) {
    if (db.chatDeletions.some((d) => d.messageId === m.id)) return false;
    if (m.channel === 'table') return role === 'gm' || role === 'player';
    if (m.channel === 'gm') return role === 'gm';
    if (m.channel === 'audience') return role !== 'none';
    return m.fromUserId === user.id || m.toUserIds.includes(user.id); // whisper
  }
  function members(campaign) {
    const owner = find('users', find('worlds', campaign.worldId).ownerId);
    return [{ userId: owner.id, name: owner.name, role: 'gm' },
      ...db.memberships.filter((m) => m.campaignId === campaign.id).map((m) => ({ userId: m.userId, name: find('users', m.userId).name, role: m.role }))];
  }
  function view(user, campaign) {
    const role = roleIn(user, campaign);
    if (role === 'none') fail(404, 'campaign not found');
    const visible = db.messages.filter((m) => m.campaignId === campaign.id && canRead(user, role, m)).slice(-200);
    return { role, members: members(campaign), messages: visible };
  }
  const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function publish(m) {
    const campaign = find('campaigns', m.campaignId);
    for (const s of subscribers) {
      if (s.campaignId === m.campaignId && canRead(s.user, roleIn(s.user, campaign), m)) write(s.res, 'message', m);
    }
  }

  const routes = {
    'GET /api/campaigns/:id/chat': (u, _b, p) => view(u, find('campaigns', p.id)),

    // { channel, text, toUserIds? (whisper), characterId? (speak as your character) }
    'POST /api/campaigns/:id/chat': (u, b, p) => {
      const campaign = find('campaigns', p.id);
      const role = roleIn(u, campaign);
      if (role === 'none') fail(404, 'campaign not found');
      const channel = oneOf(b.channel ?? 'table', CHANNELS, 'channel');
      if (channel === 'gm' && role !== 'gm') fail(403, 'only GMs use the GM channel');
      if ((channel === 'table' || channel === 'whisper') && role === 'spectator') fail(403, 'spectators chat in the audience channel');
      const text = str(b.text, 'text', 2000);
      let toUserIds = [];
      if (channel === 'whisper') {
        const allowed = new Set(members(campaign).filter((m) => m.role !== 'spectator' && m.userId !== u.id).map((m) => m.userId));
        if (!Array.isArray(b.toUserIds) || !b.toUserIds.length || b.toUserIds.some((x) => !allowed.has(x))) fail(400, 'whisper to one or more players or the GM of this campaign');
        toUserIds = [...new Set(b.toUserIds)];
      }
      let as = null;
      if (b.characterId != null) {
        const c = find('characters', b.characterId);
        if (c.campaignId !== campaign.id || !characterOwner(u, c)) fail(403, 'you can only speak as your own character');
        as = c.name;
      }
      const now = Date.now();
      const times = (recent.get(u.id) || []).filter((t) => now - t < RATE.windowMs);
      if (times.length >= RATE.count) fail(429, 'slow down: too many messages');
      recent.set(u.id, [...times, now]);
      const m = { id: id(), worldId: campaign.worldId, campaignId: campaign.id, channel, fromUserId: u.id, fromName: u.name, asCharacter: as,
        toUserIds, toNames: toUserIds.map((x) => find('users', x).name), text, at: new Date(now).toISOString() };
      db.messages.push(m);
      publish(m);
      return m;
    },

    // GM moderation: the message disappears for everyone; the deletion is kept for the audit trail.
    'DELETE /api/messages/:id': (u, _b, p) => {
      const m = find('messages', p.id);
      need(u, m.worldId, 'gm');
      if (!db.chatDeletions.some((d) => d.messageId === m.id)) db.chatDeletions.push({ id: id(), messageId: m.id, by: u.id, at: new Date().toISOString() });
      record(u.id, 'chat.deleted', { messageId: m.id, channel: m.channel, from: m.fromUserId });
      for (const s of subscribers) if (s.campaignId === m.campaignId) write(s.res, 'deleted', { id: m.id });
      return { ok: true };
    },
  };

  function stream(req, res, user, campaignId) {
    const campaign = find('campaigns', campaignId);
    const first = view(user, campaign); // throws before headers if not a member
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    write(res, 'snapshot', first);
    const sub = { res, user, campaignId };
    subscribers.add(sub);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); subscribers.delete(sub); });
  }

  // Campaign-wide notices on the chat stream (e.g. the GM's live scene), shaped per recipient.
  const broadcast = (campaignId, event, dataFor) => { for (const s of subscribers) if (s.campaignId === campaignId) write(s.res, event, dataFor(s.user)); };
  return { routes, stream, subscribers, broadcast };
};
