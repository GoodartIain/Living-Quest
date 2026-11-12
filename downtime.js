// Milestone 8: campaign clock and downtime. Game time is a day counter plus minute of the day per campaign; only the GM moves it,
// directly or by publishing a downtime window. Players book activities on specific days; the server refuses overlaps,
// keeps rival claims on a unique resource as "conflicted" for the GM, and applies approved results in one publish.
'use strict';

// Starting templates; the GM edits them per window. Days and rewards are table-design defaults, not SRD rules.
const TEMPLATES = [
  { key: 'crafting', name: 'Crafting', days: 5, resolution: 'manual' },
  { key: 'training', name: 'Training', days: 10, resolution: 'manual' },
  { key: 'research', name: 'Research', days: 5, resolution: 'assisted', skill: 'Investigation', dc: 12 },
  { key: 'socialising', name: 'Socialising and rumours', days: 3, resolution: 'assisted', skill: 'Persuasion', dc: 12 },
  { key: 'work', name: 'Working a trade', days: 7, resolution: 'auto', rewardGp: 7 },
  { key: 'recovery', name: 'Rest and recovery', days: 3, resolution: 'auto' },
  { key: 'exploration', name: 'Exploring nearby', days: 2, resolution: 'manual' },
  { key: 'sidequest', name: 'Side quest', days: 3, resolution: 'manual' },
];
const LIVE = ['proposed', 'resolved', 'conflicted', 'approved']; // statuses that occupy days and claims
const UNRESOLVED = ['proposed', 'resolved', 'conflicted'];

module.exports = function downtime({ db, find, fail, need, record, id, check, rules, chars, onClock = () => {}, adventures = null }) {
  const { str, oneOf, num, bool } = check;
  const calendarOf = (c) => find('worlds', c.worldId).settings.calendar;
  function label(cal, day) {
    const perYear = cal.daysPerMonth * cal.monthsPerYear;
    const m = Math.floor((day % perYear) / cal.daysPerMonth);
    const month = (cal.monthNames && cal.monthNames[m]) || `Month ${m + 1}`;
    return `${(day % cal.daysPerMonth) + 1} ${month}, Year ${Math.floor(day / perYear) + 1}`;
  }
  const clockOf = (c) => c.clock.day;
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const clockView = (c) => ({ day: c.clock.day, minute: c.clock.minute, time: hhmm(c.clock.minute), label: label(calendarOf(c), c.clock.day) });
  // Every clock move goes through here, so NPC routines (npcs.js) see the time that passed.
  function moveClock(c, day, minute) {
    const from = c.clock.day * 1440 + c.clock.minute;
    c.clock = { day, minute };
    onClock(c, from);
  }
  const isGm = (u, c) => find('worlds', c.worldId).ownerId === u.id;
  const ownsCharacter = (u, ch) => ch.ownerId === u.id;
  const windowOpen = (camp) => db.downtimes.find((w) => w.campaignId === camp.id && (w.status === 'open' || w.status === 'paused'));

  function validTemplates(list, worldId) {
    if (!Array.isArray(list) || !list.length || list.length > 30) fail(400, 'activities: choose 1 to 30');
    const keys = new Set();
    return list.map((a) => {
      const t = typeof a === 'string' ? TEMPLATES.find((x) => x.key === a) || fail(400, `unknown activity ${a}`) : a;
      const key = str(t.key, 'activity key', 40);
      if (!/^[a-z0-9-]+$/.test(key) || keys.has(key)) fail(400, 'activity keys must be unique lowercase words');
      keys.add(key);
      // A side quest activity plays a GM-authored adventure (quests.js) and resolves from it.
      const adventureId = t.adventureId ? (adventures || fail(400, 'side quests are not available')).validAdventureId(worldId, t.adventureId) : null;
      const resolution = adventureId ? 'adventure' : oneOf(t.resolution ?? 'manual', ['manual', 'assisted', 'auto'], 'resolution');
      const skill = t.skill == null ? null : rules.SKILLS[t.skill] ? t.skill : fail(400, `unknown skill ${t.skill}`);
      if (resolution === 'assisted' && !skill) fail(400, `${t.name}: assisted resolution needs a skill and DC`);
      return { key, name: str(t.name, 'activity name', 60), days: num(t.days, 'days', 1, 365, true), resolution, skill,
        dc: skill ? num(t.dc ?? 12, 'dc', 1, 40, true) : null, gpCost: num(t.gpCost ?? 0, 'gpCost', 0, 1e6, true),
        rewardGp: num(t.rewardGp ?? 0, 'rewardGp', 0, 1e6, true), rewardXp: num(t.rewardXp ?? 0, 'rewardXp', 0, 1e6, true),
        rewardItem: t.rewardItem ? str(t.rewardItem, 'rewardItem', 80) : '', repeatable: t.repeatable !== false, adventureId };
    });
  }
  // What a successful activity grants, before the GM edits it.
  const rewardsOf = (t, success) => (success ? { rewardGp: t.rewardGp, rewardXp: t.rewardXp, rewardItem: t.rewardItem } : { rewardGp: 0, rewardXp: 0, rewardItem: '' });

  function view(u, c) {
    const gm = isGm(u, c);
    if (!gm && !db.memberships.some((m) => m.userId === u.id && m.campaignId === c.id)) fail(404, 'campaign not found');
    const cal = calendarOf(c);
    const mine = new Set(db.characters.filter((ch) => ch.campaignId === c.id && ownsCharacter(u, ch)).map((ch) => ch.id));
    return {
      calendar: cal, clock: clockView(c), templates: gm ? TEMPLATES : undefined, gm,
      bookable: db.characters.filter((ch) => ch.campaignId === c.id && (gm || mine.has(ch.id))).map((ch) => ({ id: ch.id, name: ch.name, gp: ch.currency.gp })),
      windows: db.downtimes.filter((w) => w.campaignId === c.id).map((w) => {
        // Players see only their own characters' activities and report lines; side quests stay private.
        const actions = db.downtimeActions.filter((a) => a.downtimeId === w.id && (gm || mine.has(a.characterId)))
          .map((a) => ({ ...a, characterName: find('characters', a.characterId).name, startLabel: label(cal, a.startDay),
            runId: adventures && adventures.runFor(a) ? adventures.runFor(a).id : null }));
        const report = w.report && { ...w.report, characters: w.report.characters.filter((r) => gm || mine.has(r.characterId)) };
        return { ...w, startLabel: label(cal, w.startDay), endLabel: label(cal, w.endDay), actions, report };
      }),
    };
  }

  const liveActions = (w) => db.downtimeActions.filter((a) => a.downtimeId === w.id && LIVE.includes(a.status));

  const routes = {
    'GET /api/campaigns/:id/downtime': (u, _b, p) => view(u, find('campaigns', p.id)),

    'PATCH /api/worlds/:id/calendar': (u, b, p) => {
      need(u, p.id, 'gm');
      const w = find('worlds', p.id);
      const cal = { ...w.settings.calendar };
      if (b.daysPerWeek !== undefined) cal.daysPerWeek = num(b.daysPerWeek, 'daysPerWeek', 1, 100, true);
      if (b.daysPerMonth !== undefined) cal.daysPerMonth = num(b.daysPerMonth, 'daysPerMonth', 1, 1000, true);
      if (b.monthsPerYear !== undefined) cal.monthsPerYear = num(b.monthsPerYear, 'monthsPerYear', 1, 100, true);
      if (b.monthNames !== undefined) {
        if (!Array.isArray(b.monthNames) || b.monthNames.length !== cal.monthsPerYear) fail(400, `monthNames must list ${cal.monthsPerYear} names`);
        cal.monthNames = b.monthNames.map((n) => str(n, 'month name', 40));
      } else if (cal.monthNames && cal.monthNames.length !== cal.monthsPerYear) delete cal.monthNames;
      w.settings = { ...w.settings, calendar: cal };
      record(u.id, 'calendar.updated', { worldId: w.id, calendar: cal });
      return cal;
    },

    // Manual time jump (GM): { advanceDays } or { advanceMinutes } or { until: 'HH:MM' } (the next time it is that time).
    // Refused while downtime is running, so the window's calendar stays consistent. Time never goes backwards.
    'POST /api/campaigns/:id/clock': (u, b, p) => {
      const c = find('campaigns', p.id);
      need(u, c.worldId, 'gm');
      if (windowOpen(c)) fail(409, 'publish or cancel the open downtime first');
      let to = c.clock.day * 1440 + c.clock.minute;
      if (b.advanceDays !== undefined) to += 1440 * num(b.advanceDays, 'advanceDays', 1, 100000, true);
      else if (b.advanceMinutes !== undefined) to += num(b.advanceMinutes, 'advanceMinutes', 1, 1440 * 100, true);
      else if (typeof b.until === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.until)) {
        const m = Number(b.until.slice(0, 2)) * 60 + Number(b.until.slice(3));
        to += ((m - c.clock.minute + 1439) % 1440) + 1;
      } else fail(400, 'give advanceDays, advanceMinutes or until (HH:MM)');
      moveClock(c, Math.floor(to / 1440), to % 1440);
      record(u.id, 'clock.advanced', { campaignId: c.id, day: c.clock.day, minute: c.clock.minute });
      return clockView(c);
    },

    // { duration, unit: days|weeks|months, deadline?, activities: [key | template] }
    'POST /api/campaigns/:id/downtime': (u, b, p) => {
      const c = find('campaigns', p.id);
      need(u, c.worldId, 'gm');
      if (windowOpen(c)) fail(409, 'this campaign already has downtime running');
      const cal = calendarOf(c);
      const unit = oneOf(b.unit ?? 'days', ['days', 'weeks', 'months'], 'unit');
      const days = num(b.duration, 'duration', 1, 1000, true) * { days: 1, weeks: cal.daysPerWeek, months: cal.daysPerMonth }[unit];
      if (b.deadline != null && Number.isNaN(Date.parse(b.deadline))) fail(400, 'deadline must be a date');
      const w = { id: id(), worldId: c.worldId, campaignId: c.id, startDay: clockOf(c), endDay: clockOf(c) + days,
        deadline: b.deadline ? new Date(b.deadline).toISOString() : null, activities: validTemplates(b.activities ?? TEMPLATES.map((t) => t.key), c.worldId),
        status: 'open', report: null, createdBy: u.id, publishedAt: null };
      db.downtimes.push(w);
      record(u.id, 'downtime.created', { downtimeId: w.id, startDay: w.startDay, endDay: w.endDay });
      return w;
    },

    // GM: pause/resume, extend or shorten (never cutting booked activities), cancel.
    'PATCH /api/downtime/:id': (u, b, p) => {
      const w = find('downtimes', p.id);
      need(u, w.worldId, 'gm');
      if (!['open', 'paused'].includes(w.status)) fail(409, `this downtime is ${w.status}`);
      if (b.status !== undefined) {
        const status = oneOf(b.status, ['open', 'paused', 'cancelled'], 'status');
        if (status === 'cancelled') for (const a of liveActions(w)) { a.status = 'cancelled'; if (adventures) adventures.abandon(a); }
        w.status = status;
      }
      if (b.endDay !== undefined) {
        const endDay = num(b.endDay, 'endDay', w.startDay + 1, w.startDay + 100000, true);
        const latest = Math.max(w.startDay, ...liveActions(w).map((a) => a.startDay + a.days));
        if (endDay < latest) fail(409, 'booked activities run past that day; reject or cancel them first');
        w.endDay = endDay;
      }
      if (b.activities !== undefined) w.activities = validTemplates(b.activities, w.worldId);
      record(u.id, 'downtime.updated', { downtimeId: w.id, status: w.status, endDay: w.endDay });
      return w;
    },

    // A player (or the GM) books an activity: { characterId, activity, startDay, details?, claim? }
    'POST /api/downtime/:id/actions': (u, b, p) => {
      const w = find('downtimes', p.id);
      const c = find('campaigns', w.campaignId);
      const gm = isGm(u, c);
      const ch = find('characters', b.characterId);
      if (ch.campaignId !== c.id || (!gm && !ownsCharacter(u, ch))) fail(403, 'book activities for your own character');
      if (w.status !== 'open') fail(409, w.status === 'paused' ? 'the GM has paused downtime' : `this downtime is ${w.status}`);
      if (!gm && w.deadline && Date.now() > Date.parse(w.deadline)) fail(409, 'the submission deadline has passed');
      const t = w.activities.find((x) => x.key === b.activity) || fail(400, 'that activity is not allowed in this downtime');
      const startDay = num(b.startDay, 'startDay', w.startDay, w.endDay - 1, true);
      if (startDay + t.days > w.endDay) fail(409, `${t.name} takes ${t.days} days and would run past the end of downtime`);
      const mine = liveActions(w).filter((a) => a.characterId === ch.id);
      const clash = mine.find((a) => startDay < a.startDay + a.days && a.startDay < startDay + t.days);
      if (clash) fail(409, `${ch.name} is busy with ${w.activities.find((x) => x.key === clash.activity).name} from day ${clash.startDay - w.startDay + 1} for ${clash.days} days`);
      if (!t.repeatable && mine.some((a) => a.activity === t.key)) fail(409, `${t.name} can only be done once`);
      if (t.gpCost > ch.currency.gp) fail(409, `${t.name} costs ${t.gpCost} gp; ${ch.name} has ${ch.currency.gp}`);
      const claim = b.claim ? str(b.claim, 'claim', 80).toLowerCase() : null;
      const a = { id: id(), worldId: w.worldId, downtimeId: w.id, campaignId: c.id, characterId: ch.id, userId: u.id, activity: t.key,
        startDay, days: t.days, details: typeof b.details === 'string' ? b.details.slice(0, 2000) : '', claim, status: 'proposed', outcome: null, gmNotes: '', decidedBy: null };
      if (t.resolution === 'assisted' || t.resolution === 'auto') { // roll now from the sheet; auto is pre-approved within the GM's preset rewards
        const roll = t.skill ? chars.rollCheck(u, ch, `skill:${t.skill}`) : null;
        const success = roll ? roll.total >= t.dc : true;
        a.outcome = { roll: roll && { formula: roll.formula, total: roll.total, dc: t.dc }, success, notes: '', ...rewardsOf(t, success) };
        a.status = t.resolution === 'auto' ? 'approved' : 'resolved';
      }
      const rivals = claim ? liveActions(w).filter((x) => x.claim === claim) : [];
      if (rivals.length) { // never grant one unique thing twice: keep every request, let the GM arbitrate
        for (const r of [...rivals, a]) r.status = 'conflicted';
      }
      db.downtimeActions.push(a);
      if (t.adventureId) adventures.startRun(u, a, t.adventureId);
      record(u.id, 'downtime.action', { downtimeId: w.id, actionId: a.id, characterId: ch.id, activity: t.key, startDay, status: a.status });
      return a;
    },

    // The player withdraws an activity the GM has not approved yet.
    'DELETE /api/downtime-actions/:id': (u, _b, p) => {
      const a = find('downtimeActions', p.id);
      const c = find('campaigns', a.campaignId);
      if (!isGm(u, c) && !ownsCharacter(u, find('characters', a.characterId))) fail(403, 'not your activity');
      if (find('downtimes', a.downtimeId).status === 'published' || a.status === 'approved' && !isGm(u, c)) fail(409, 'this activity is already decided');
      a.status = 'cancelled';
      if (adventures) adventures.abandon(a);
      record(u.id, 'downtime.action.cancelled', { actionId: a.id });
      return a;
    },

    // GM decision: { status: approved|rejected|proposed (postpone), outcome?: { success, notes, rewardGp, rewardXp, rewardItem }, gmNotes? }
    'PATCH /api/downtime-actions/:id': (u, b, p) => {
      const a = find('downtimeActions', p.id);
      need(u, a.worldId, 'gm');
      const w = find('downtimes', a.downtimeId);
      if (w.status === 'published' || w.status === 'cancelled') fail(409, `this downtime is ${w.status}`);
      if (a.status === 'cancelled') fail(409, 'the player cancelled this activity');
      const status = oneOf(b.status, ['approved', 'rejected', 'proposed'], 'status');
      if (b.outcome !== undefined) {
        const o = b.outcome || {};
        a.outcome = { ...(a.outcome || {}), success: bool(o.success ?? true, 'success'), notes: typeof o.notes === 'string' ? o.notes.slice(0, 2000) : '',
          rewardGp: num(o.rewardGp ?? 0, 'rewardGp', 0, 1e6, true), rewardXp: num(o.rewardXp ?? 0, 'rewardXp', 0, 1e6, true),
          rewardItem: o.rewardItem ? str(o.rewardItem, 'rewardItem', 80) : '' };
      }
      if (status === 'approved' && !a.outcome) fail(400, 'give an outcome when approving a manual activity');
      const blocked = status === 'approved' && adventures && adventures.blockApproval(a);
      if (blocked) fail(409, blocked);
      if (b.gmNotes !== undefined) a.gmNotes = typeof b.gmNotes === 'string' ? b.gmNotes.slice(0, 2000) : '';
      const lost = [];
      if (status === 'approved' && a.claim) { // arbitration: the other claimants lose the unique resource
        for (const r of liveActions(w).filter((x) => x.claim === a.claim && x.id !== a.id)) {
          r.status = 'rejected';
          if (adventures) adventures.abandon(r);
          r.gmNotes = `${a.claim} went to ${find('characters', a.characterId).name}.`;
          lost.push(r.id);
        }
      }
      a.status = status === 'proposed' ? (a.outcome ? 'resolved' : 'proposed') : status;
      if (status === 'rejected' && adventures) adventures.abandon(a);
      a.decidedBy = u.id;
      record(u.id, 'downtime.decision', { actionId: a.id, status: a.status, outcome: a.outcome, rejectedRivals: lost });
      return a;
    },

    // Apply every approved result at once, move the clock to the end of downtime, and keep a report.
    'POST /api/downtime/:id/publish': (u, b, p) => {
      const w = find('downtimes', p.id);
      const c = find('campaigns', w.campaignId);
      need(u, c.worldId, 'gm');
      if (!['open', 'paused'].includes(w.status)) fail(409, `this downtime is ${w.status}`);
      const all = db.downtimeActions.filter((a) => a.downtimeId === w.id);
      const open = all.filter((a) => UNRESOLVED.includes(a.status));
      if (open.length && b.unresolved !== 'cancel') fail(409, `${open.length} activit${open.length === 1 ? 'y is' : 'ies are'} still waiting for a decision; decide them or publish with unresolved: "cancel"`);
      const approved = all.filter((a) => a.status === 'approved');
      // Check every character can pay before changing anything.
      const totals = new Map();
      for (const a of approved) {
        const t = w.activities.find((x) => x.key === a.activity);
        const s = totals.get(a.characterId) || { gp: 0, xp: 0, items: [] };
        s.gp += (a.outcome.rewardGp || 0) - t.gpCost;
        s.xp += a.outcome.rewardXp || 0;
        if (a.outcome.rewardItem) s.items.push(a.outcome.rewardItem);
        totals.set(a.characterId, s);
      }
      for (const [cid, s] of totals) {
        const ch = find('characters', cid);
        if (ch.currency.gp + s.gp < 0) fail(409, `${ch.name} cannot pay: needs ${-s.gp} gp more than they will have`);
      }
      const xpMode = c.advancement.mode === 'xp';
      for (const [cid, s] of totals) {
        const ch = find('characters', cid);
        ch.currency = { ...ch.currency, gp: ch.currency.gp + s.gp };
        ch.inventory = [...ch.inventory, ...s.items.map((name) => ({ id: id(), name, qty: 1, notes: 'from downtime' }))];
        if (xpMode && s.xp) chars.giveXp(ch, s.xp, 'downtime', `Downtime, ${label(calendarOf(c), w.startDay)} to ${label(calendarOf(c), w.endDay)}`, u.id);
        chars.sync(ch);
      }
      for (const a of open) { a.status = 'cancelled'; if (adventures) adventures.abandon(a); }
      w.status = 'published';
      w.publishedAt = new Date().toISOString();
      // In-game time reaches the end of downtime now (the world simulation may already have moved it part of the way).
      if (c.clock.day < w.endDay) moveClock(c, w.endDay, c.clock.minute);
      // Side-quest outcomes (discoveries, items, quests, world events…) land after the clock moved, so NPCs react at the new time.
      const effects = new Map(approved.map((a) => [a.id, adventures ? adventures.apply(a, c, u.id) : []]));
      const cal = calendarOf(c);
      w.report = {
        from: label(cal, w.startDay), to: label(cal, w.endDay), days: w.endDay - w.startDay, cancelled: open.length,
        xpApplied: xpMode,
        characters: [...new Set(all.map((a) => a.characterId))].map((cid) => {
          const ch = find('characters', cid);
          const s = totals.get(cid) || { gp: 0, xp: 0, items: [] };
          return { characterId: cid, name: ch.name, gp: s.gp, xp: xpMode ? s.xp : 0, items: s.items,
            timeline: all.filter((a) => a.characterId === cid).sort((x, y) => x.startDay - y.startDay).map((a) => ({
              activity: w.activities.find((x) => x.key === a.activity).name, from: label(cal, a.startDay), days: a.days, status: a.status,
              success: a.outcome ? a.outcome.success : null, notes: a.outcome ? a.outcome.notes : '', effects: effects.get(a.id) || [] })) };
        }),
      };
      record(u.id, 'downtime.published', { downtimeId: w.id, day: w.endDay, approved: approved.length, cancelled: open.length });
      return w;
    },
  };

  return { routes, label, moveClock, windowOpen };
};
