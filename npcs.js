// Milestone 9: NPC routines. An NPC's whereabouts are never simulated tick by tick: they are computed from its schedule,
// the campaign clock and the reactions/overrides recorded for that campaign, so idle NPCs cost nothing. When time moves,
// the transitions in between are written to the event history and NPCs whose current step names a scene get a token there.
'use strict';

const LEVELS = ['static', 'scheduled', 'reactive', 'simulated', 'ai-assisted'];
const DAY = 1440;
const DETAIL_DAYS = 3; // longer jumps log one summary per NPC instead of every step
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

module.exports = function npcs({ db, find, fail, need, record, id, check, viewer, SEES, VISIBILITY, publishScene }) {
  const { str, oneOf, num } = check;
  const worldOf = (x) => find('worlds', x.worldId);
  const nowOf = (c) => c.clock.day * DAY + c.clock.minute;
  const autonomyOf = (n) => (n.autonomy === 'inherit' ? worldOf(n).settings.npcAutonomy : n.autonomy);
  const atLeast = (n, level) => LEVELS.indexOf(autonomyOf(n)) >= LEVELS.indexOf(level);
  // Scene tokens follow one campaign per world: its first campaign (worlds normally run one).
  const tokenCampaign = (worldId) => db.campaigns.find((c) => c.worldId === worldId);
  const within = (locId, ancestorId) => { for (let l = locId; l; l = find('locations', l).parentId) if (l === ancestorId) return true; return false; };
  const placeName = (locId) => (locId ? find('locations', locId).name : 'nowhere');

  // ---- validation -------------------------------------------------------------------------------------------
  const minuteOf = (v, name) => {
    if (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v)) { const [h, m] = v.split(':').map(Number); if (h < 24 && m < 60) return h * 60 + m; }
    if (typeof v === 'number') return num(v, name, 0, DAY - 1, true);
    return fail(400, `${name} must be a time like 08:30`);
  };
  const locIn = (worldId, locId, name) => { if (find('locations', locId).worldId !== worldId) fail(400, `${name} belongs to another world`); return locId; };
  // Where on a scene: optional, but a scene needs a cell inside it and must sit at that location.
  function spot(worldId, b, locationId) {
    if (b.sceneId == null) return { sceneId: null, x: null, y: null };
    const s = find('scenes', b.sceneId);
    if (s.worldId !== worldId || s.locationId !== locationId) fail(400, `scene ${s.name} is not at ${placeName(locationId)}`);
    return { sceneId: s.id, x: num(b.x ?? 0, 'x', 0, s.cols - 1, true), y: num(b.y ?? 0, 'y', 0, s.rows - 1, true) };
  }
  function validSchedule(w, list) {
    if (!Array.isArray(list) || list.length > 50) fail(400, 'schedule: up to 50 steps');
    const week = w.settings.calendar.daysPerWeek;
    return list.map((e) => {
      const locationId = locIn(w.id, e.locationId, 'schedule location');
      const days = e.days == null ? [] : e.days;
      if (!Array.isArray(days) || days.some((d) => !Number.isInteger(d) || d < 1 || d > week)) fail(400, `days must be weekday numbers 1..${week}`);
      return { from: minuteOf(e.from, 'from'), days: [...new Set(days)].sort((a, b) => a - b), locationId, activity: str(e.activity, 'activity', 80), ...spot(w.id, e, locationId) };
    }).sort((a, b) => a.from - b.from);
  }
  function validReactions(w, list) {
    if (!Array.isArray(list) || list.length > 20) fail(400, 'reactions: up to 20');
    return list.map((r) => {
      const where = r.locationId ?? 'stay';
      const locationId = where === 'stay' || where === 'home' ? where : locIn(w.id, where, 'reaction location');
      const then = oneOf(r.then ?? 'resume', ['resume', 'relocate'], 'then');
      let relocate = null;
      if (then === 'relocate') {
        const rl = r.relocate || {};
        const to = locIn(w.id, rl.to, 'relocate.to');
        relocate = { from: locIn(w.id, rl.from, 'relocate.from'), to, ...spot(w.id, rl, to) };
      }
      return { on: str(r.on, 'event name', 40).toLowerCase(), activity: str(r.activity, 'activity', 80), locationId,
        ...(locationId !== 'stay' && locationId !== 'home' ? spot(w.id, r, locationId) : { sceneId: null, x: null, y: null }),
        minutes: num(r.minutes ?? 60, 'minutes', 1, 60 * DAY, true), then, relocate };
    });
  }

  // ---- where is an NPC at time T in campaign c ---------------------------------------------------------------
  const eventsOf = (n, c) => db.npcEvents.filter((e) => e.npcId === n.id && e.campaignId === c.id);
  function scheduleAt(n, c, T) { // routine changes ("relocate") take effect when their reaction ends
    let sched = n.schedule;
    for (const e of eventsOf(n, c).filter((x) => x.after === 'relocate' && x.toTime <= T).sort((a, b) => a.toTime - b.toTime)) {
      const r = e.relocate;
      sched = sched.map((s) => (s.locationId === r.from ? { ...s, locationId: r.to, sceneId: r.sceneId, x: r.x, y: r.y } : s));
    }
    return sched;
  }
  function stateAt(n, c, T) {
    const active = eventsOf(n, c).filter((e) => e.fromTime <= T && T < e.toTime).sort((a, b) => b.fromTime - a.fromTime)[0];
    if (active) return { source: active.kind, cause: active.cause, activity: active.activity, locationId: active.locationId, sceneId: active.sceneId, x: active.x, y: active.y, until: active.toTime };
    const home = { source: 'home', activity: n.occupation ? `Off duty (${n.occupation})` : 'At home', locationId: n.homeLocationId, sceneId: null, x: null, y: null };
    if (!atLeast(n, 'scheduled')) return home;
    const sched = scheduleAt(n, c, T);
    const week = worldOf(n).settings.calendar.daysPerWeek;
    const day = Math.floor(T / DAY);
    for (let back = 0; back <= week; back++) { // today's last step so far, else the latest step on an earlier day
      const d = day - back;
      const wd = (((d % week) + week) % week) + 1;
      const step = sched.filter((s) => (!s.days.length || s.days.includes(wd)) && (back > 0 || s.from <= T % DAY)).pop();
      if (step) return { source: 'routine', activity: step.activity, locationId: step.locationId, sceneId: step.sceneId, x: step.x, y: step.y };
    }
    return home;
  }
  const brief = (s, T) => ({ ...s, place: placeName(s.locationId), ...(s.until != null && { untilLabel: hhmm(s.until % DAY) }), time: hhmm(T % DAY) });

  // ---- event history --------------------------------------------------------------------------------------
  const log = (c, npcId, T, kind, text, locationId = null) =>
    db.npcLog.push({ id: id(), worldId: c.worldId, campaignId: c.id, npcId, time: T, kind, text, locationId });
  function logTransitions(c, from, to) {
    for (const n of db.npcs.filter((x) => x.worldId === c.worldId && atLeast(x, 'scheduled'))) {
      if (to - from > DETAIL_DAYS * DAY) {
        const s = stateAt(n, c, to);
        log(c, n.id, to, 'summary', `${n.name}: ${Math.round((to - from) / DAY)} days passed; now ${s.activity.toLowerCase()} at ${placeName(s.locationId)}`, s.locationId);
        continue;
      }
      const times = new Set();
      for (let d = Math.floor(from / DAY); d <= Math.floor(to / DAY); d++) for (const s of scheduleAt(n, c, to)) times.add(d * DAY + s.from);
      for (const e of eventsOf(n, c)) { times.add(e.fromTime); times.add(e.toTime); }
      let prev = stateAt(n, c, from);
      for (const T of [...times].filter((t) => t > from && t <= to).sort((a, b) => a - b)) {
        const s = stateAt(n, c, T);
        const ended = eventsOf(n, c).find((e) => e.toTime === T && e.after === 'relocate');
        if (ended) log(c, n.id, T, 'relocated', `${n.name} now works at ${placeName(ended.relocate.to)} instead of ${placeName(ended.relocate.from)}`, ended.relocate.to);
        if (s.locationId === prev.locationId && s.activity === prev.activity && s.sceneId === prev.sceneId && s.x === prev.x && s.y === prev.y) continue;
        const resumed = prev.source !== 'routine' && prev.source !== 'home' && (s.source === 'routine' || s.source === 'home');
        log(c, n.id, T, resumed ? 'resumed' : s.locationId === prev.locationId ? 'activity' : 'moved',
          `${n.name}${resumed ? ' resumes the routine:' : ''} ${s.activity.toLowerCase()} at ${placeName(s.locationId)}`, s.locationId);
        prev = s;
      }
    }
  }

  // ---- scene tokens ---------------------------------------------------------------------------------------
  function syncTokens(worldId) {
    const c = tokenCampaign(worldId);
    const touched = new Set();
    const T = c && nowOf(c);
    for (const t of db.tokens.filter((x) => x.worldId === worldId && x.npcId)) {
      const n = db.npcs.find((x) => x.id === t.npcId);
      const s = n && c && stateAt(n, c, T);
      if (!s || s.sceneId !== t.sceneId) { db.tokens.splice(db.tokens.indexOf(t), 1); touched.add(t.sceneId); }
    }
    if (c) for (const n of db.npcs.filter((x) => x.worldId === worldId)) {
      const s = stateAt(n, c, T);
      if (!s.sceneId) continue;
      const t = db.tokens.find((x) => x.npcId === n.id);
      const want = { name: n.name, x: s.x, y: s.y, visibility: n.visibility, pageId: n.pageId, color: n.color };
      if (!t) {
        db.tokens.push({ id: id(), worldId, sceneId: s.sceneId, size: 1, controlledBy: [], characterId: null, npcId: n.id, ...want });
        touched.add(s.sceneId);
      } else if (Object.entries(want).some(([k, v]) => t[k] !== v)) { Object.assign(t, want); touched.add(t.sceneId); }
    }
    for (const sid of touched) publishScene(sid);
  }

  // Called by the clock (manual advance or downtime publish) after it moved from `from`.
  function onClock(c, from) {
    logTransitions(c, from, nowOf(c));
    if (tokenCampaign(c.worldId) === c) syncTokens(c.worldId);
  }

  // Players see an NPC at a place they can see, if the NPC's visibility allows, at their own campaign's time.
  // The campaign whose clock a viewer lives in: the GM's is the token campaign, others their own campaign.
  const campaignFor = (user, worldId, role) => (role === 'gm' ? tokenCampaign(worldId)
    : db.campaigns.find((x) => x.worldId === worldId && (user.broadcast ? x.id === user.broadcast : db.memberships.some((m) => m.userId === user.id && m.campaignId === x.id))));
  function hereFor(user, loc) {
    const v = viewer(user, loc.worldId);
    const c = campaignFor(user, loc.worldId, v.role);
    if (!c) return [];
    const T = nowOf(c);
    return db.npcs.filter((n) => n.worldId === loc.worldId && SEES[v.role].includes(n.visibility)).map((n) => [n, stateAt(n, c, T)])
      .filter(([, s]) => s.locationId === loc.id)
      .map(([n, s]) => ({ id: n.id, name: n.name, occupation: n.occupation, activity: s.activity, pageId: n.pageId && v.seesPage(find('pages', n.pageId)) ? n.pageId : null }));
  }

  // Also used by side-quest outcomes and scene triggers (Milestone 10). `by` is the actor recorded in the audit log.
  function worldEvent(c, by, kindIn, locationIn, note, cause = 'gm') {
    const kind = str(kindIn, 'event name', 40).toLowerCase();
    const where = locationIn == null ? null : locIn(c.worldId, locationIn, 'event location');
    const T = nowOf(c);
    log(c, null, T, 'event', `${kind}${where ? ` at ${placeName(where)}` : ''}${note ? `: ${String(note).slice(0, 200)}` : ''}${cause === 'gm' ? '' : ` (${cause})`}`, where);
    const reacted = [];
    for (const n of db.npcs.filter((x) => x.worldId === c.worldId && atLeast(x, 'reactive'))) {
      const r = n.reactions.find((x) => x.on === kind);
      const s = stateAt(n, c, T);
      if (!r || (where && !(s.locationId && within(s.locationId, where)))) continue;
      const locationId = r.locationId === 'stay' ? s.locationId : r.locationId === 'home' ? n.homeLocationId : r.locationId;
      const e = { id: id(), worldId: c.worldId, campaignId: c.id, npcId: n.id, kind: 'reaction', cause: kind, fromTime: T, toTime: T + r.minutes,
        activity: r.activity, locationId, ...(r.locationId === 'stay' ? { sceneId: s.sceneId, x: s.x, y: s.y } : { sceneId: r.sceneId, x: r.x, y: r.y }),
        after: r.then, relocate: r.relocate };
      db.npcEvents.push(e);
      log(c, n.id, T, 'reacted', `${n.name} reacts to the ${kind}: ${r.activity.toLowerCase()} at ${placeName(locationId)} until ${hhmm(e.toTime % DAY)}`, locationId);
      reacted.push({ npcId: n.id, name: n.name, activity: r.activity, until: e.toTime });
    }
    record(by, 'world.event', { campaignId: c.id, kind, locationId: where, cause, reacted: reacted.map((x) => x.npcId) });
    if (tokenCampaign(c.worldId) === c) syncTokens(c.worldId);
    return { kind, reacted };
  }

  // Put an NPC somewhere for a while (GM, or a committed world development); it resumes its routine afterwards.
  function override(c, n, b, by, cause) {
    const locationId = locIn(n.worldId, b.locationId, 'location');
    const T = nowOf(c);
    const e = { id: id(), worldId: n.worldId, campaignId: c.id, npcId: n.id, kind: 'override', cause, fromTime: T, toTime: T + num(b.minutes ?? 60, 'minutes', 1, 365 * DAY, true),
      activity: str(b.activity, 'activity', 80), locationId, ...spot(n.worldId, b, locationId), after: 'resume', relocate: null };
    db.npcEvents.push(e);
    log(c, n.id, T, 'override', `${cause === 'gm' ? 'GM' : cause}: ${n.name} ${e.activity.toLowerCase()} at ${placeName(locationId)} until ${hhmm(e.toTime % DAY)}`, locationId);
    record(by, 'npc.override', { npcId: n.id, campaignId: c.id, until: e.toTime, cause });
    if (tokenCampaign(c.worldId) === c) syncTokens(c.worldId);
  }
  // For previews: who would react to an event at time T, without changing anything.
  function wouldReact(c, kindIn, where, T) {
    const kind = String(kindIn).toLowerCase();
    return db.npcs.filter((n) => n.worldId === c.worldId && atLeast(n, 'reactive') && n.reactions.some((r) => r.on === kind))
      .filter((n) => { const s = stateAt(n, c, T); return !where || (s.locationId && within(s.locationId, where)); })
      .map((n) => `${n.name}: ${n.reactions.find((r) => r.on === kind).activity.toLowerCase()}`);
  }

  function fields(w, b, n = {}) {
    const out = {};
    if (b.pageId !== undefined) {
      if (b.pageId !== null && find('pages', b.pageId).worldId !== w.id) fail(400, 'page belongs to another world');
      out.pageId = b.pageId;
    }
    if (b.name !== undefined) out.name = str(b.name, 'name', 80);
    if (b.occupation !== undefined) out.occupation = b.occupation ? str(b.occupation, 'occupation', 80) : '';
    if (b.homeLocationId !== undefined) out.homeLocationId = b.homeLocationId === null ? null : locIn(w.id, b.homeLocationId, 'home');
    if (b.visibility !== undefined) out.visibility = oneOf(b.visibility, VISIBILITY, 'visibility');
    if (b.autonomy !== undefined) out.autonomy = oneOf(b.autonomy, ['inherit', ...LEVELS], 'autonomy');
    if (b.importance !== undefined) out.importance = oneOf(b.importance, ['background', 'minor', 'major'], 'importance');
    if (b.color !== undefined) out.color = /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : fail(400, 'color must be #rrggbb');
    if (b.schedule !== undefined) out.schedule = validSchedule(w, b.schedule);
    if (b.reactions !== undefined) out.reactions = validReactions(w, b.reactions);
    return out;
  }
  const campaignIn = (w, cid) => { const c = find('campaigns', cid ?? (tokenCampaign(w.id) || fail(409, 'create a campaign first')).id); if (c.worldId !== w.id) fail(400, 'campaign belongs to another world'); return c; };
  const view = (n, c) => ({ ...n, now: c ? brief(stateAt(n, c, nowOf(c)), nowOf(c)) : null, effectiveAutonomy: autonomyOf(n) });

  const routes = {
    // GM: every NPC with where it is now in the chosen campaign (default: the one driving scene tokens).
    'GET /api/worlds/:id/npcs': (u, _b, p) => {
      const q = p.query;
      need(u, p.id, 'gm');
      const w = find('worlds', p.id);
      const c = tokenCampaign(w.id) && campaignIn(w, q.campaignId || undefined);
      return { campaignId: c ? c.id : null, time: c ? hhmm(c.clock.minute) : null, day: c ? c.clock.day : null,
        npcs: db.npcs.filter((n) => n.worldId === w.id).map((n) => view(n, c)),
        // for the editor's pickers
        campaigns: db.campaigns.filter((x) => x.worldId === w.id).map((x) => ({ id: x.id, name: x.name })),
        locations: db.locations.filter((l) => l.worldId === w.id && l.parentId).map((l) => {
          const path = [];
          for (let x = l; x && x.parentId; x = find('locations', x.parentId)) path.unshift(x.name);
          return { id: l.id, name: path.join(' › ') };
        }).sort((a, b) => a.name.localeCompare(b.name)),
        scenes: db.scenes.filter((x) => x.worldId === w.id).map((x) => ({ id: x.id, name: x.name, locationId: x.locationId, cols: x.cols, rows: x.rows })),
        pages: db.pages.filter((x) => x.worldId === w.id && x.kind === 'npc').map((x) => ({ id: x.id, title: x.title })),
        allPages: db.pages.filter((x) => x.worldId === w.id && !x.locationId).map((x) => ({ id: x.id, title: x.title })) };
    },
    'POST /api/worlds/:id/npcs': (u, b, p) => {
      need(u, p.id, 'gm');
      const w = find('worlds', p.id);
      const n = { id: id(), worldId: w.id, pageId: null, name: '', occupation: '', homeLocationId: null, visibility: 'party', autonomy: 'inherit',
        importance: 'minor', color: '#4b6a8a', schedule: [], reactions: [] };
      // Linked to a wiki NPC page, the profile takes the page's title unless given a name.
      Object.assign(n, fields(w, { ...b, name: b.name ?? (b.pageId ? find('pages', b.pageId).title : '') }, n));
      db.npcs.push(n);
      record(u.id, 'npc.created', { npcId: n.id });
      syncTokens(w.id);
      return view(n, tokenCampaign(w.id));
    },
    'PATCH /api/npcs/:id': (u, b, p) => {
      const n = find('npcs', p.id);
      need(u, n.worldId, 'gm');
      const ch = fields(worldOf(n), b, n);
      if (!Object.keys(ch).length) fail(400, 'nothing to change');
      Object.assign(n, ch);
      record(u.id, 'npc.updated', { npcId: n.id, fields: Object.keys(ch) });
      syncTokens(n.worldId);
      return view(n, tokenCampaign(n.worldId));
    },
    'DELETE /api/npcs/:id': (u, _b, p) => {
      const n = find('npcs', p.id);
      need(u, n.worldId, 'gm');
      db.npcs.splice(db.npcs.indexOf(n), 1);
      record(u.id, 'npc.deleted', { npcId: n.id, name: n.name });
      syncTokens(n.worldId);
      return { ok: true };
    },

    // A world event in one campaign, e.g. { kind: 'fire', locationId: market }: reactive NPCs there react now.
    'POST /api/campaigns/:id/events': (u, b, p) => {
      const c = find('campaigns', p.id);
      need(u, c.worldId, 'gm');
      return worldEvent(c, u.id, b.kind, b.locationId, b.note);
    },

    // GM override: put an NPC somewhere for a while, whatever its autonomy; it resumes its routine afterwards.
    'POST /api/npcs/:id/override': (u, b, p) => {
      const n = find('npcs', p.id);
      need(u, n.worldId, 'gm');
      const c = campaignIn(worldOf(n), b.campaignId);
      override(c, n, b, u.id, 'gm');
      return view(n, c);
    },

    // Event history, newest first (GM).
    'GET /api/campaigns/:id/npc-log': (u, _b, p) => {
      const q = p.query;
      const c = find('campaigns', p.id);
      need(u, c.worldId, 'gm');
      return db.npcLog.filter((x) => x.campaignId === c.id && (!q.npcId || x.npcId === q.npcId)).slice(-300).reverse()
        .map((x) => ({ ...x, day: Math.floor(x.time / DAY), clock: hhmm(x.time % DAY) }));
    },
  };

  return { routes, onClock, hereFor, syncTokens, stateAt, hhmm, worldEvent, tokenCampaign, campaignFor, override, wouldReact, placeName };
};
