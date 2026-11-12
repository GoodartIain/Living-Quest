// Milestone 11: persistent world simulation. Factions have starting values; every later change is a recorded world
// change with provenance (rule, faction, time, approver), so a campaign's state = starting values + its changes.
// Time passes through a preview: bounded, seeded faction activities and GM-scheduled happenings become a draft timeline
// the GM reviews (routine/minor pre-approved, major needs a decision, protected never commits). Commit re-runs the same
// deterministic simulation, refuses if anything changed since the preview, then applies it in time order, moving the clock.
'use strict';
const crypto = require('node:crypto');

const DAY = 1440;
const SIG = ['routine', 'minor', 'major', 'protected'];
const KINDS = ['influence', 'resources', 'standing', 'territory', 'rumour', 'event', 'npc'];
const seeded = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const bare = ({ before, after, summary, ...e }) => e; // an effect without its preview annotations

module.exports = function world({ db, find, fail, need, record, id, check, SEES, VISIBILITY, people, clock }) {
  const { str, oneOf, num } = check;
  const nowOf = (c) => c.clock.day * DAY + c.clock.minute;
  const hhmm = people.hhmm;
  const when = (c, T) => `${clock.label(find('worlds', c.worldId).settings.calendar, Math.floor(T / DAY))}, ${hhmm(T % DAY)}`;
  const threshold = (w) => (w.settings.simulation && w.settings.simulation.majorThreshold) || 25;
  const factionsOf = (worldId) => db.factions.filter((f) => f.worldId === worldId);
  const fname = (fid) => (fid === 'party' ? 'the party' : find('factions', fid).name);

  // ---- validation -----------------------------------------------------------------------------------------
  const factionIn = (worldId, fid, name) => { const f = find('factions', fid); if (f.worldId !== worldId) fail(400, `${name} belongs to another world`); return f.id; };
  const locIn = (worldId, lid) => { if (find('locations', lid).worldId !== worldId) fail(400, 'location belongs to another world'); return lid; };
  function validEffect(worldId, e, own) {
    const kind = oneOf(e.kind, KINDS, 'effect kind');
    const subject = () => (e.factionId ? factionIn(worldId, e.factionId, 'faction') : own || fail(400, `${kind}: which faction?`));
    switch (kind) {
      case 'influence': return { kind, factionId: subject(), delta: num(e.delta, 'delta', -100, 100, true) };
      case 'resources': return { kind, factionId: subject(), delta: num(e.delta, 'delta', -1e6, 1e6, true) };
      case 'standing': {
        const factionId = subject();
        const target = e.target === 'party' ? 'party' : factionIn(worldId, e.target, 'target');
        if (target === factionId) fail(400, 'a faction has no standing with itself');
        return { kind, factionId, target, delta: num(e.delta, 'delta', -100, 100, true) };
      }
      case 'territory': return { kind, factionId: subject(), locationId: locIn(worldId, e.locationId), gain: e.gain !== false };
      case 'rumour': return { kind, text: str(e.text, 'rumour', 300), locationId: e.locationId == null ? null : locIn(worldId, e.locationId), visibility: oneOf(e.visibility ?? 'party', VISIBILITY, 'visibility') };
      case 'event': return { kind, eventKind: str(e.eventKind, 'event name', 40).toLowerCase(), locationId: e.locationId == null ? null : locIn(worldId, e.locationId) };
      case 'npc': {
        const n = find('npcs', e.npcId);
        if (n.worldId !== worldId) fail(400, 'NPC belongs to another world');
        return { kind, npcId: n.id, locationId: locIn(worldId, e.locationId), activity: str(e.activity, 'activity', 80), minutes: num(e.minutes ?? DAY, 'minutes', 1, 60 * DAY, true) };
      }
      default: return fail(400, 'unknown effect');
    }
  }
  const effectsIn = (worldId, list, own) => {
    if (!Array.isArray(list) || !list.length || list.length > 10) fail(400, 'effects: 1 to 10');
    return list.map((e) => validEffect(worldId, e, own));
  };
  function factionFields(w, b, f = {}) {
    const out = {};
    if (b.name !== undefined) out.name = str(b.name, 'name', 80);
    if (b.pageId !== undefined) { if (b.pageId !== null && find('pages', b.pageId).worldId !== w.id) fail(400, 'page belongs to another world'); out.pageId = b.pageId; }
    if (b.visibility !== undefined) out.visibility = oneOf(b.visibility, VISIBILITY, 'visibility');
    if (b.influence !== undefined) out.influence = num(b.influence, 'influence', 0, 100, true);
    if (b.resources !== undefined) out.resources = num(b.resources, 'resources', 0, 1e6, true);
    if (b.goals !== undefined) out.goals = typeof b.goals === 'string' ? b.goals.slice(0, 2000) : '';
    if (b.leader !== undefined) out.leader = typeof b.leader === 'string' ? b.leader.slice(0, 120) : '';
    if (b.territory !== undefined) {
      if (!Array.isArray(b.territory) || b.territory.length > 50) fail(400, 'territory: up to 50 places');
      out.territory = [...new Set(b.territory.map((l) => locIn(w.id, l)))];
    }
    if (b.standings !== undefined) {
      if (typeof b.standings !== 'object' || Array.isArray(b.standings)) fail(400, 'standings: { factionId|party: -100..100 }');
      out.standings = Object.fromEntries(Object.entries(b.standings).map(([k, v]) => [k === 'party' ? 'party' : factionIn(w.id, k, 'standing target'), num(v, 'standing', -100, 100, true)]));
    }
    if (b.activities !== undefined) {
      if (!Array.isArray(b.activities) || b.activities.length > 20) fail(400, 'activities: up to 20');
      out.activities = b.activities.map((a) => ({ id: typeof a.id === 'string' && a.id.length <= 40 ? a.id : id(), name: str(a.name, 'activity name', 80),
        every: num(a.every ?? 7, 'every', 1, 365, true), chance: num(a.chance ?? 100, 'chance', 1, 100, true), cost: num(a.cost ?? 0, 'cost', 0, 1e6, true),
        significance: oneOf(a.significance ?? 'minor', SIG, 'significance'), effects: effectsIn(w.id, a.effects, f.id) }));
    }
    return out;
  }

  // ---- state = starting values + recorded changes -------------------------------------------------------------
  function stateOf(c) {
    const st = Object.fromEntries(factionsOf(c.worldId).map((f) => [f.id, { influence: f.influence, resources: f.resources, territory: new Set(f.territory), standings: { ...f.standings } }]));
    for (const ch of db.worldChanges.filter((x) => x.campaignId === c.id)) applyTo(st, ch.kind, ch.data);
    return st;
  }
  // Applies one effect to a state and returns what actually changed (clamped), or null for non-state effects.
  function applyTo(st, kind, d) {
    const s = st[d.factionId];
    if (!s) return null;
    if (kind === 'influence') { const b = s.influence; s.influence = clamp(b + d.delta, 0, 100); return { before: b, after: s.influence }; }
    if (kind === 'resources') { const b = s.resources; s.resources = clamp(b + d.delta, 0, 1e9); return { before: b, after: s.resources }; }
    if (kind === 'standing') { const b = s.standings[d.target] || 0; s.standings[d.target] = clamp(b + d.delta, -100, 100); return { before: b, after: s.standings[d.target] }; }
    if (kind === 'territory') { const b = s.territory.has(d.locationId); if (d.gain) s.territory.add(d.locationId); else s.territory.delete(d.locationId); return { before: b, after: d.gain }; }
    return null;
  }
  const clone = (st) => Object.fromEntries(Object.entries(st).map(([k, v]) => [k, { ...v, territory: new Set(v.territory), standings: { ...v.standings } }]));
  function describe(e, r) {
    switch (e.kind) {
      case 'influence': return `${fname(e.factionId)} influence ${r.before} → ${r.after}`;
      case 'resources': return `${fname(e.factionId)} resources ${r.before} → ${r.after}`;
      case 'standing': return `${fname(e.factionId)} toward ${fname(e.target)}: ${r.before} → ${r.after}`;
      case 'territory': return `${fname(e.factionId)} ${e.gain ? 'takes' : 'loses'} ${people.placeName(e.locationId)}`;
      case 'rumour': return `Rumour${e.locationId ? ` in ${people.placeName(e.locationId)}` : ''}: "${e.text}"`;
      case 'event': return `World event "${e.eventKind}"${e.locationId ? ` at ${people.placeName(e.locationId)}` : ''}`;
      case 'npc': return `${find('npcs', e.npcId).name} goes to ${people.placeName(e.locationId)}: ${e.activity.toLowerCase()} for ${Math.round(e.minutes / 60)} h`;
      default: return e.kind;
    }
  }

  // What a rule would do, for developments that did not happen (no before/after to show).
  const planned = (e) => (e.delta !== undefined ? `${fname(e.factionId)} ${e.kind === 'standing' ? `standing toward ${fname(e.target)}` : e.kind} ${e.delta >= 0 ? '+' : ''}${e.delta}` : describe(e, {}));

  // ---- the simulation -------------------------------------------------------------------------------------
  function simulate(c, days, decisions = {}) {
    const w = find('worlds', c.worldId);
    const T0 = nowOf(c), T1 = T0 + days * DAY;
    const st = clone(stateOf(c));
    const cands = [];
    for (const f of factionsOf(c.worldId)) for (const a of f.activities) {
      const phase = seeded(f.id, a.id) % a.every; // spread factions over the week instead of all on one day
      for (let d = Math.floor(T0 / DAY); d <= Math.floor(T1 / DAY); d++) {
        const t = d * DAY + 720; // activities resolve at midday
        if (t <= T0 || t > T1 || d % a.every !== phase) continue;
        if (seeded(c.id, f.id, a.id, d) % 100 >= a.chance) continue; // bounded chance, same every time for the same day
        cands.push({ id: `a:${f.id}:${a.id}:${d}`, time: t, factionId: f.id, source: `${f.name}: ${a.name}`, rule: `every ${a.every} d, ${a.chance}%${a.cost ? `, costs ${a.cost}` : ''}`,
          significance: a.significance, cost: a.cost, effects: a.effects });
      }
    }
    for (const hp of db.happenings.filter((x) => x.campaignId === c.id && x.status === 'scheduled' && x.time > T0 && x.time <= T1))
      cands.push({ id: `h:${hp.id}`, happeningId: hp.id, time: hp.time, factionId: null, source: `Scheduled: ${hp.label}`, rule: 'GM schedule', significance: hp.significance, cost: 0, effects: hp.effects });
    cands.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    const devs = cands.map((cd) => {
      const dev = { id: cd.id, time: cd.time, when: when(c, cd.time), source: cd.source, rule: cd.rule, factionId: cd.factionId, happeningId: cd.happeningId || null,
        significance: cd.significance, status: '', reason: '', effects: [], reactions: [] };
      if (cd.significance === 'protected') { dev.status = 'blocked'; dev.reason = 'protected: only the GM can make this happen'; }
      else if (cd.cost && st[cd.factionId].resources < cd.cost) { dev.status = 'skipped'; dev.reason = `needs ${cd.cost} resources, has ${st[cd.factionId].resources}`; }
      if (dev.status) { dev.effects = cd.effects.map((e) => ({ ...e, summary: planned(e) })); return dev; }
      // Preview each effect on a scratch copy; big swings or territory changes are major whatever the rule says.
      const trial = clone(st);
      if (cd.cost) applyTo(trial, 'resources', { factionId: cd.factionId, delta: -cd.cost });
      for (const e of cd.effects) {
        const r = applyTo(trial, e.kind, e);
        dev.effects.push({ ...e, before: r ? r.before : null, after: r ? r.after : null, summary: describe(e, r || {}) });
        if ((['influence', 'standing'].includes(e.kind) && Math.abs(e.delta) >= threshold(w)) || e.kind === 'territory') dev.significance = SIG.indexOf(dev.significance) < 2 ? 'major' : dev.significance;
        if (e.kind === 'event') dev.reactions.push(...people.wouldReact(c, e.eventKind, e.locationId, cd.time));
      }
      const d = decisions[dev.id];
      dev.status = d === 'rejected' ? 'rejected' : d === 'approved' || dev.significance !== 'major' ? 'approved' : 'undecided';
      if (dev.status === 'approved') Object.assign(st, trial); // later developments see this one
      return dev;
    });
    const end = factionsOf(c.worldId).map((f) => ({ id: f.id, name: f.name, influence: st[f.id].influence, resources: st[f.id].resources,
      territory: [...st[f.id].territory].map((l) => people.placeName(l)), standings: Object.fromEntries(Object.entries(st[f.id].standings).map(([k, v]) => [fname(k), v])) }));
    const npcs = db.npcs.filter((n) => n.worldId === c.worldId).map((n) => { const s = people.stateAt(n, c, T1); return { name: n.name, activity: s.activity, place: people.placeName(s.locationId) }; });
    // Anything that would make commit differ from what the GM saw changes this fingerprint.
    const hash = crypto.createHash('sha256').update(JSON.stringify([T0, T1, devs.map((x) => [x.id, x.status, x.effects.map((e) => [e.before, e.after])]),
      db.worldChanges.filter((x) => x.campaignId === c.id).length, factionsOf(c.worldId), db.happenings.filter((x) => x.campaignId === c.id)])).digest('hex').slice(0, 16);
    return { from: when(c, T0), to: when(c, T1), days, developments: devs, factions: end, npcs, hash, undecided: devs.filter((x) => x.status === 'undecided').length };
  }

  // Record a change and do its side effect. `T` must be the campaign's current time.
  function commitEffect(c, e, meta) {
    const data = { ...e };
    if (['influence', 'resources', 'standing', 'territory'].includes(e.kind)) {
      const r = applyTo(stateOf(c), e.kind, e); // store the clamped delta so replays add up to what the GM saw
      if (e.kind === 'influence' || e.kind === 'resources' || e.kind === 'standing') data.delta = r.after - r.before;
    }
    db.worldChanges.push({ id: id(), worldId: c.worldId, campaignId: c.id, time: nowOf(c), kind: e.kind, data, factionId: e.factionId || meta.factionId || null,
      source: meta.source, significance: meta.significance, by: meta.by, commitId: meta.commitId });
    if (e.kind === 'event') people.worldEvent(c, meta.by, e.eventKind, e.locationId, meta.source, 'world simulation');
    if (e.kind === 'npc') people.override(c, find('npcs', e.npcId), { activity: e.activity, locationId: e.locationId, minutes: e.minutes }, meta.by, meta.source);
  }

  const gmCampaign = (u, cid) => { const c = find('campaigns', cid); need(u, c.worldId, 'gm'); return c; };
  const days = (b) => num(b.days, 'days', 1, 365, true);
  const standingWord = (v) => (v >= 60 ? 'allied' : v >= 20 ? 'friendly' : v > -20 ? 'neutral' : v > -60 ? 'unfriendly' : 'hostile');

  const routes = {
    // GM: everything; players: visible factions, how they regard the party (as a word), and rumours.
    'GET /api/campaigns/:id/world': (u, _b, p) => {
      const c = find('campaigns', p.id);
      const role = need(u, c.worldId, 'spectator');
      const v = role === 'gm' ? null : { role };
      const st = stateOf(c);
      const sees = (vis) => SEES[role].includes(vis);
      const rumours = db.worldChanges.filter((x) => x.campaignId === c.id && x.kind === 'rumour' && sees(x.data.visibility)).reverse()
        .map((x) => ({ text: x.data.text, where: x.data.locationId ? people.placeName(x.data.locationId) : null, when: when(c, x.time) }));
      if (v) {
        return { factions: factionsOf(c.worldId).filter((f) => sees(f.visibility)).map((f) => ({ id: f.id, name: f.name, leader: f.leader,
          towardParty: standingWord(st[f.id].standings.party || 0) })), rumours };
      }
      return { now: when(c, nowOf(c)), majorThreshold: threshold(find('worlds', c.worldId)), rumours,
        factions: factionsOf(c.worldId).map((f) => ({ ...f, current: { influence: st[f.id].influence, resources: st[f.id].resources, territory: [...st[f.id].territory], standings: st[f.id].standings } })),
        happenings: db.happenings.filter((x) => x.campaignId === c.id).map((x) => ({ ...x, when: when(c, x.time), effectsText: x.effects.map((e) => describe(e, { before: '', after: '' })) })),
        history: db.worldChanges.filter((x) => x.campaignId === c.id).slice(-200).reverse().map((x) => ({ ...x, when: when(c, x.time),
          text: planned(x.data) })),
        locations: db.locations.filter((l) => l.worldId === c.worldId && l.parentId).map((l) => ({ id: l.id, name: l.name })),
        npcs: db.npcs.filter((n) => n.worldId === c.worldId).map((n) => ({ id: n.id, name: n.name })) };
    },
    'POST /api/worlds/:id/factions': (u, b, p) => {
      need(u, p.id, 'gm');
      const w = find('worlds', p.id);
      const f = { id: id(), worldId: w.id, name: '', pageId: null, visibility: 'party', influence: 50, resources: 100, territory: [], standings: {}, goals: '', leader: '', activities: [] };
      Object.assign(f, factionFields(w, b, f));
      if (!f.name) fail(400, 'name must be a non-empty string up to 80 chars');
      db.factions.push(f);
      record(u.id, 'faction.created', { factionId: f.id });
      return f;
    },
    'PATCH /api/factions/:id': (u, b, p) => {
      const f = find('factions', p.id);
      need(u, f.worldId, 'gm');
      const ch = factionFields(find('worlds', f.worldId), b, f);
      if (!Object.keys(ch).length) fail(400, 'nothing to change');
      Object.assign(f, ch);
      record(u.id, 'faction.updated', { factionId: f.id, fields: Object.keys(ch) });
      return f;
    },
    'PATCH /api/worlds/:id/simulation': (u, b, p) => {
      need(u, p.id, 'gm');
      const w = find('worlds', p.id);
      w.settings = { ...w.settings, simulation: { majorThreshold: num(b.majorThreshold, 'majorThreshold', 1, 100, true) } };
      record(u.id, 'simulation.settings', w.settings.simulation);
      return w.settings.simulation;
    },
    // GM-planned one-off developments: { inDays, at: 'HH:MM', label, significance, effects }
    'POST /api/campaigns/:id/happenings': (u, b, p) => {
      const c = gmCampaign(u, p.id);
      const at = typeof b.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.at) ? Number(b.at.slice(0, 2)) * 60 + Number(b.at.slice(3)) : 720;
      const time = (c.clock.day + num(b.inDays, 'inDays', 0, 3650, true)) * DAY + at;
      if (time <= nowOf(c)) fail(400, 'that time has already passed');
      const hp = { id: id(), worldId: c.worldId, campaignId: c.id, time, label: str(b.label, 'label', 120), significance: oneOf(b.significance ?? 'minor', SIG, 'significance'),
        effects: effectsIn(c.worldId, b.effects, null), status: 'scheduled' };
      db.happenings.push(hp);
      record(u.id, 'happening.created', { happeningId: hp.id, time });
      return hp;
    },
    'DELETE /api/happenings/:id': (u, _b, p) => {
      const hp = find('happenings', p.id);
      need(u, hp.worldId, 'gm');
      if (hp.status !== 'scheduled') fail(409, `this happening is ${hp.status}`);
      hp.status = 'cancelled';
      record(u.id, 'happening.cancelled', { happeningId: hp.id });
      return hp;
    },
    // A GM decision applied now (e.g. the party helped the guild): { effects, note }
    'POST /api/campaigns/:id/world-changes': (u, b, p) => {
      const c = gmCampaign(u, p.id);
      const effects = effectsIn(c.worldId, b.effects, null);
      const meta = { source: `GM: ${b.note ? str(b.note, 'note', 200) : 'decision'}`, significance: 'major', by: u.id, commitId: id() };
      for (const e of effects) commitEffect(c, e, meta);
      record(u.id, 'world.changed', { campaignId: c.id, effects: effects.length });
      return { ok: true };
    },
    // Draft timeline: nothing changes. { days, decisions: { <developmentId>: approved|rejected } }
    'POST /api/campaigns/:id/simulate': (u, b, p) => {
      const c = gmCampaign(u, p.id);
      return simulate(c, days(b), b.decisions || {});
    },
    // Make it canon: { days, decisions, hash } — the hash from the preview the GM looked at.
    'POST /api/campaigns/:id/simulate/commit': (u, b, p) => {
      const c = gmCampaign(u, p.id);
      const sim = simulate(c, days(b), b.decisions || {});
      // During downtime the world moves on too, but only up to the downtime's last day (publishing it finishes there).
      const w = clock.windowOpen(c);
      if (w && nowOf(c) + sim.days * DAY > w.endDay * DAY + c.clock.minute) fail(409, `downtime ends ${clock.label(find('worlds', c.worldId).settings.calendar, w.endDay)}; simulate up to then, then publish it`);
      if (sim.hash !== b.hash) fail(409, 'the world changed since this preview; preview again');
      if (sim.undecided) fail(409, `${sim.undecided} major development${sim.undecided === 1 ? ' needs' : 's need'} your decision`);
      const commitId = id();
      const T1 = nowOf(c) + sim.days * DAY;
      for (const dev of sim.developments) {
        const hp = dev.happeningId && find('happenings', dev.happeningId);
        if (hp) hp.status = { approved: 'done', rejected: 'cancelled', skipped: 'skipped', blocked: 'blocked' }[dev.status];
        if (dev.status !== 'approved') continue;
        clock.moveClock(c, Math.floor(dev.time / DAY), dev.time % DAY); // NPC routines catch up to this moment
        const meta = { source: dev.source, significance: dev.significance, by: u.id, commitId, factionId: dev.factionId };
        const cost = dev.factionId && find('factions', dev.factionId).activities.find((a) => dev.id.includes(`:${a.id}:`));
        if (cost && cost.cost) commitEffect(c, { kind: 'resources', factionId: dev.factionId, delta: -cost.cost }, { ...meta, source: `${dev.source} (cost)` });
        for (const e of dev.effects) commitEffect(c, bare(e), meta);
      }
      clock.moveClock(c, Math.floor(T1 / DAY), T1 % DAY);
      const applied = sim.developments.filter((x) => x.status === 'approved').length;
      record(u.id, 'simulation.committed', { campaignId: c.id, commitId, days: sim.days, applied, rejected: sim.developments.filter((x) => x.status === 'rejected').length });
      return { commitId, applied, now: when(c, nowOf(c)) };
    },
  };
  return { routes };
};
