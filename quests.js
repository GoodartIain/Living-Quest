// Milestone 10: the quest log and branching side quests ("adventures") played during downtime.
// An adventure is a GM-authored graph of nodes. A player plays it alone through a downtime activity: choices move along
// the graph, skill checks are rolled from the sheet, effects collect on the way. Small rewards inside the adventure's
// limits resolve by themselves; anything consequential waits for the GM, and nothing touches the campaign until the
// downtime is published. Players only ever see the node they are on and the ones they have passed.
'use strict';

const EFFECTS = ['gp', 'xp', 'item', 'discover', 'reveal', 'quest', 'journal', 'event'];
const ALWAYS_GM = new Set(['reveal', 'event']); // canon changes and world events always need the GM
const QUEST_KINDS = ['main', 'optional', 'personal', 'downtime', 'faction'];
const QUEST_STATUS = ['active', 'completed', 'failed'];

module.exports = function quests({ db, find, fail, need, record, id, check, rules, chars, people }) {
  const { str, oneOf, num, bool } = check;
  const isGm = (u, worldId) => find('worlds', worldId).ownerId === u.id;
  const placeName = (lid) => find('locations', lid).name;

  // ---- quest log ------------------------------------------------------------------------------------------
  const owns = (u, characterId) => characterId && find('characters', characterId).ownerId === u.id;
  const seesQuest = (u, q) => isGm(u, q.worldId) || (q.visibility === 'party' && (!q.characterId || owns(u, q.characterId)));
  const questView = (u, q) => (isGm(u, q.worldId) ? q : { ...q, notes: undefined });
  function questFields(c, b) {
    const out = {};
    if (b.title !== undefined) out.title = str(b.title, 'title', 120);
    if (b.description !== undefined) out.description = typeof b.description === 'string' ? b.description.slice(0, 5000) : '';
    if (b.notes !== undefined) out.notes = typeof b.notes === 'string' ? b.notes.slice(0, 5000) : '';
    if (b.kind !== undefined) out.kind = oneOf(b.kind, QUEST_KINDS, 'kind');
    if (b.visibility !== undefined) out.visibility = oneOf(b.visibility, ['gm', 'party'], 'visibility');
    if (b.status !== undefined) out.status = oneOf(b.status, QUEST_STATUS, 'status');
    if (b.characterId !== undefined) {
      if (b.characterId !== null && find('characters', b.characterId).campaignId !== c.id) fail(400, 'character is not in this campaign');
      out.characterId = b.characterId;
    }
    if (b.objectives !== undefined) {
      if (!Array.isArray(b.objectives) || b.objectives.length > 30) fail(400, 'objectives: up to 30');
      out.objectives = b.objectives.map((o) => ({ id: typeof o.id === 'string' && o.id.length <= 40 ? o.id : id(), text: str(o.text, 'objective', 200), done: o.done === true }));
    }
    return out;
  }

  // ---- adventures -----------------------------------------------------------------------------------------
  const checkOk = (chk) => { const [k, w] = String(chk).split(':'); return (k === 'skill' && rules.SKILLS[w] !== undefined) || ((k === 'ability' || k === 'save') && rules.ABILITIES.includes(w)); };
  function validEffect(worldId, e) {
    const type = oneOf(e.type, EFFECTS, 'effect type');
    const out = { type, major: e.major === true };
    if (type === 'gp' || type === 'xp') out.amount = num(e.amount, 'amount', 1, 1e6, true);
    if (type === 'item') out.name = str(e.name, 'item name', 80);
    if (type === 'discover' || type === 'event') {
      if (type === 'discover' || e.locationId != null) {
        if (find('locations', e.locationId).worldId !== worldId) fail(400, 'location belongs to another world');
        out.locationId = e.locationId;
      } else out.locationId = null;
    }
    if (type === 'event') out.kind = str(e.kind, 'event name', 40).toLowerCase();
    if (type === 'reveal') { if (find('pages', e.pageId).worldId !== worldId) fail(400, 'page belongs to another world'); out.pageId = e.pageId; }
    if (type === 'journal') out.text = str(e.text, 'journal text', 2000);
    if (type === 'quest') {
      const q = find('quests', e.questId);
      if (q.worldId !== worldId) fail(400, 'quest belongs to another world');
      out.questId = q.id;
      if (e.questStatus != null) out.questStatus = oneOf(e.questStatus, QUEST_STATUS, 'questStatus');
      if (e.objectiveId != null) { if (!q.objectives.some((o) => o.id === e.objectiveId)) fail(400, 'no such objective'); out.objectiveId = e.objectiveId; }
      out.reveal = e.reveal === true;
    }
    return out;
  }
  function validAdventure(worldId, b, old = {}) {
    const nodesIn = b.nodes ?? old.nodes;
    if (!nodesIn || typeof nodesIn !== 'object' || Array.isArray(nodesIn)) fail(400, 'nodes must be an object of named nodes');
    const keys = Object.keys(nodesIn);
    if (!keys.length || keys.length > 100) fail(400, 'an adventure has 1 to 100 nodes');
    for (const k of keys) if (!/^[a-z0-9-]{1,30}$/.test(k)) fail(400, `node name ${k}: lowercase letters, digits and dashes`);
    const exists = (k, where) => (keys.includes(k) ? k : fail(400, `${where} leads to unknown node ${k}`));
    const nodes = {};
    for (const k of keys) {
      const n = nodesIn[k] || {};
      const choices = (n.choices || []).map((ch, i) => {
        const label = str(ch.label, `${k} choice ${i + 1}`, 120);
        if (ch.check != null) {
          if (!checkOk(ch.check)) fail(400, `${k}: check must be skill:<Skill>, ability:<ab> or save:<ab>`);
          return { label, check: ch.check, dc: num(ch.dc ?? 12, 'dc', 1, 40, true), success: exists(ch.success, k), failure: exists(ch.failure, k) };
        }
        return { label, to: exists(ch.to, k) };
      });
      if (choices.length > 10) fail(400, `${k}: up to 10 choices`);
      const effects = (n.effects || []).map((e) => validEffect(worldId, e));
      if (effects.length > 10) fail(400, `${k}: up to 10 effects`);
      nodes[k] = { text: str(n.text, `${k} text`, 5000), choices, effects, outcome: choices.length ? null : oneOf(n.outcome ?? 'success', ['success', 'failure'], 'outcome') };
    }
    const start = exists(b.start ?? old.start ?? keys[0], 'start');
    return { title: str(b.title ?? old.title, 'title', 120), summary: typeof (b.summary ?? old.summary) === 'string' ? (b.summary ?? old.summary).slice(0, 2000) : '',
      start, nodes, maxGp: num(b.maxGp ?? old.maxGp ?? 50, 'maxGp', 0, 1e6, true), maxXp: num(b.maxXp ?? old.maxXp ?? 100, 'maxXp', 0, 1e6, true) };
  }

  // ---- runs -----------------------------------------------------------------------------------------------
  const actionOf = (r) => find('downtimeActions', r.actionId);
  const live = (r) => ['proposed', 'resolved', 'conflicted'].includes(actionOf(r).status) && ['open'].includes(find('downtimes', actionOf(r).downtimeId).status);
  function enter(r, adv, key) {
    r.node = key;
    for (const e of adv.nodes[key].effects) r.effects.push({ ...e, node: key, gm: e.major || ALWAYS_GM.has(e.type), status: 'pending' });
    if (!adv.nodes[key].choices.length) finish(r, adv);
  }
  function finish(r, adv) {
    r.status = 'finished';
    r.outcome = adv.nodes[r.node].outcome;
    const sum = { gp: 0, xp: 0 };
    for (const e of r.effects) {
      if (e.type === 'gp' || e.type === 'xp') { // bounded rewards: anything past the adventure's limit goes to the GM
        sum[e.type] += e.amount;
        if (sum[e.type] > (e.type === 'gp' ? adv.maxGp : adv.maxXp)) e.gm = true;
      }
      if (!e.gm) e.status = 'auto';
    }
    syncAction(r);
  }
  // The downtime activity mirrors the run: gp/xp go in the outcome the downtime publish already applies.
  function syncAction(r) {
    const a = actionOf(r);
    const ok = (e) => e.status === 'auto' || e.status === 'approved';
    const total = (t) => r.effects.filter((e) => e.type === t && ok(e)).reduce((s, e) => s + e.amount, 0);
    a.outcome = { success: r.outcome === 'success', notes: find('adventures', r.adventureId).nodes[r.node].text.slice(0, 300),
      rewardGp: total('gp'), rewardXp: total('xp'), rewardItem: '', run: r.id };
    // Nothing left for the GM: the adventure resolved itself within its limits.
    if (a.status !== 'conflicted') a.status = r.effects.some((e) => e.status === 'pending') ? 'resolved' : 'approved';
  }
  function runView(u, r) {
    const adv = find('adventures', r.adventureId);
    const gm = isGm(u, r.worldId);
    if (!gm && r.userId !== u.id && !owns(u, r.characterId)) fail(404, 'run not found');
    const node = adv.nodes[r.node];
    return { id: r.id, title: adv.title, summary: adv.summary, status: r.status, outcome: r.outcome, question: r.question, answer: r.answer, characterId: r.characterId, actionId: r.actionId,
      node: { key: gm ? r.node : undefined, text: node.text, end: !node.choices.length, choices: node.choices.map((c, i) => ({ i, label: c.label, check: c.check ? `${c.check.split(':')[1]} check` : null })) },
      path: r.path, effects: r.effects.map((e, i) => ({ ...e, i, label: describe(e) })), ...(gm && { nodes: Object.keys(adv.nodes) }) };
  }
  function describe(e) {
    switch (e.type) {
      case 'gp': return `${e.amount} gp`;
      case 'xp': return `${e.amount} XP`;
      case 'item': return `Item: ${e.name}`;
      case 'discover': return `Discover ${placeName(e.locationId)}`;
      case 'reveal': return `Reveal wiki page "${find('pages', e.pageId).title}" to players`;
      case 'journal': return `Journal: ${e.text.slice(0, 60)}`;
      case 'event': return `World event "${e.kind}"${e.locationId ? ` at ${placeName(e.locationId)}` : ''}`;
      case 'quest': { const q = find('quests', e.questId); return `Quest "${q.title}"${e.questStatus ? `: ${e.questStatus}` : ''}${e.objectiveId ? `: objective "${q.objectives.find((o) => o.id === e.objectiveId).text}" done` : ''}${e.reveal ? ' (revealed)' : ''}`; }
      default: return e.type;
    }
  }

  // Called by downtime when a player books an adventure activity.
  function startRun(u, action, adventureId) {
    const adv = find('adventures', adventureId);
    const r = { id: id(), worldId: action.worldId, campaignId: action.campaignId, adventureId: adv.id, characterId: action.characterId, userId: u.id, actionId: action.id,
      node: adv.start, status: 'running', path: [], effects: [], question: '', answer: '', outcome: null };
    db.questRuns.push(r);
    enter(r, adv, adv.start);
    return r;
  }
  const runFor = (action) => db.questRuns.find((r) => r.actionId === action.id);
  // Downtime asks before a GM approves the activity.
  function blockApproval(action) {
    const r = runFor(action);
    if (!r) return null;
    if (r.status !== 'finished') return 'the side quest is not finished yet';
    if (r.effects.some((e) => e.status === 'pending')) return 'decide the side quest\'s pending outcomes first';
    return null;
  }
  // Downtime publish: apply the approved non-coin effects of an approved activity. gp/xp were applied from the outcome.
  function apply(action, c, by) {
    const r = runFor(action);
    if (!r) return [];
    const ch = find('characters', r.characterId);
    const lines = [];
    for (const e of r.effects.filter((x) => x.status === 'auto' || x.status === 'approved')) {
      if (e.type === 'item') ch.inventory = [...ch.inventory, { id: id(), name: e.name, qty: 1, notes: `from ${find('adventures', r.adventureId).title}` }];
      if (e.type === 'discover' && !db.discoveries.some((d) => d.locationId === e.locationId && d.campaignId === c.id))
        db.discoveries.push({ id: id(), worldId: c.worldId, locationId: e.locationId, campaignId: c.id });
      if (e.type === 'reveal') {
        const pg = find('pages', e.pageId);
        if (!pg.locationId && pg.visibility === 'gm') {
          const { title, body, gmNotes, kind, visibility } = pg;
          db.revisions.push({ id: id(), pageId: pg.id, worldId: pg.worldId, at: new Date().toISOString(), actor: by, title, body, gmNotes, kind, visibility });
          pg.visibility = 'party';
        }
      }
      if (e.type === 'journal') ch.journal = [...ch.journal, { id: id(), at: new Date().toISOString(), by: 'Downtime', text: e.text, visibility: 'private' }];
      if (e.type === 'quest') {
        const q = find('quests', e.questId);
        if (e.questStatus) q.status = e.questStatus;
        if (e.objectiveId) q.objectives = q.objectives.map((o) => (o.id === e.objectiveId ? { ...o, done: true } : o));
        if (e.reveal) q.visibility = 'party';
      }
      if (e.type === 'event') people.worldEvent(c, by, e.kind, e.locationId, `after ${ch.name}'s side quest`, 'side quest');
      if (e.type !== 'gp' && e.type !== 'xp') lines.push(describe(e));
    }
    return lines;
  }
  // Unfinished runs end with the downtime (or when their activity is cancelled or rejected).
  function abandon(action) { const r = runFor(action); if (r && r.status !== 'finished') r.status = 'abandoned'; }

  const myRun = (u, rid) => {
    const r = find('questRuns', rid);
    if (r.userId !== u.id && !owns(u, r.characterId)) fail(isGm(u, r.worldId) ? 403 : 404, isGm(u, r.worldId) ? 'only the player plays' : 'run not found');
    if (!live(r)) fail(409, 'this side quest is closed');
    return r;
  };
  const gmRun = (u, rid) => { const r = find('questRuns', rid); need(u, r.worldId, 'gm'); return r; };

  const routes = {
    // Quest log.
    'GET /api/campaigns/:id/quests': (u, _b, p) => {
      const c = find('campaigns', p.id);
      const role = need(u, c.worldId, 'spectator');
      if (role === 'spectator') return [];
      return db.quests.filter((q) => q.campaignId === c.id && seesQuest(u, q)).map((q) => ({ ...questView(u, q), characterName: q.characterId ? find('characters', q.characterId).name : null }));
    },
    'POST /api/campaigns/:id/quests': (u, b, p) => {
      const c = find('campaigns', p.id);
      need(u, c.worldId, 'gm');
      const q = { id: id(), worldId: c.worldId, campaignId: c.id, title: '', description: '', notes: '', kind: 'optional', visibility: 'party', status: 'active', characterId: null, objectives: [],
        ...questFields(c, { kind: 'optional', ...b }) };
      if (!q.title) fail(400, 'title must be a non-empty string up to 120 chars');
      if (q.kind === 'personal' && !q.characterId) fail(400, 'a personal quest belongs to a character');
      db.quests.push(q);
      record(u.id, 'quest.created', { questId: q.id });
      return q;
    },
    'PATCH /api/quests/:id': (u, b, p) => {
      const q = find('quests', p.id);
      need(u, q.worldId, 'gm');
      const ch = questFields(find('campaigns', q.campaignId), b);
      if (!Object.keys(ch).length) fail(400, 'nothing to change');
      Object.assign(q, ch);
      record(u.id, 'quest.updated', { questId: q.id, fields: Object.keys(ch) });
      return q;
    },

    // Adventures (GM only: their content is secret until played).
    'GET /api/worlds/:id/adventures': (u, _b, p) => { need(u, p.id, 'gm'); return db.adventures.filter((a) => a.worldId === p.id); },
    'POST /api/worlds/:id/adventures': (u, b, p) => {
      need(u, p.id, 'gm');
      const a = { id: id(), worldId: p.id, ...validAdventure(p.id, b) };
      db.adventures.push(a);
      record(u.id, 'adventure.created', { adventureId: a.id });
      return a;
    },
    'PATCH /api/adventures/:id': (u, b, p) => {
      const a = find('adventures', p.id);
      need(u, a.worldId, 'gm');
      if (db.questRuns.some((r) => r.adventureId === a.id && ['running', 'waiting'].includes(r.status))) fail(409, 'someone is playing this adventure; edit it when they finish');
      Object.assign(a, validAdventure(a.worldId, b, a));
      record(u.id, 'adventure.updated', { adventureId: a.id });
      return a;
    },

    // Playing.
    'GET /api/quest-runs/:id': (u, _b, p) => runView(u, find('questRuns', p.id)),
    'POST /api/quest-runs/:id/choose': (u, b, p) => {
      const r = myRun(u, p.id);
      if (r.status !== 'running') fail(409, r.status === 'waiting' ? 'waiting for the GM to answer' : `this side quest is ${r.status}`);
      const adv = find('adventures', r.adventureId);
      const node = adv.nodes[r.node];
      const choice = node.choices[num(b.index, 'index', 0, node.choices.length - 1, true)];
      let to = choice.to;
      let roll = null;
      if (choice.check) {
        const res = chars.rollCheck(u, find('characters', r.characterId), choice.check);
        roll = { formula: res.formula, total: res.total, dc: choice.dc, success: res.total >= choice.dc };
        to = roll.success ? choice.success : choice.failure;
      }
      r.path = [...r.path, { text: node.text, choice: choice.label, roll }];
      enter(r, adv, to);
      record(u.id, 'quest.step', { runId: r.id, to, roll: roll && roll.total });
      return runView(u, r);
    },
    // Pause and escalate: the player wants something the adventure does not cover.
    'POST /api/quest-runs/:id/ask': (u, b, p) => {
      const r = myRun(u, p.id);
      if (r.status !== 'running') fail(409, `this side quest is ${r.status}`);
      r.question = str(b.text, 'question', 1000);
      r.answer = '';
      r.status = 'waiting';
      record(u.id, 'quest.asked', { runId: r.id });
      return runView(u, r);
    },
    // GM answers: continue at a node of their choice, or end it here with an outcome.
    'POST /api/quest-runs/:id/answer': (u, b, p) => {
      const r = gmRun(u, p.id);
      if (r.status !== 'waiting') fail(409, 'nobody is waiting for an answer');
      if (!live(r)) fail(409, 'this side quest is closed');
      const adv = find('adventures', r.adventureId);
      const answer = str(b.text, 'answer', 2000); // validate everything before changing the run
      const end = b.end != null ? oneOf(b.end, ['success', 'failure'], 'end') : null;
      if (!end && !(b.to && adv.nodes[b.to])) fail(400, 'continue at which node? (to), or end it (end: success|failure)');
      r.answer = answer;
      r.path = [...r.path, { text: adv.nodes[r.node].text, choice: `Asked the GM: ${r.question}`, answer, roll: null }];
      r.status = 'running';
      if (end) finish(r, { ...adv, nodes: { ...adv.nodes, [r.node]: { ...adv.nodes[r.node], outcome: end } } });
      else enter(r, adv, b.to);
      record(u.id, 'quest.answered', { runId: r.id });
      return runView(u, r);
    },
    // GM decides each consequential outcome: { decisions: { <index>: 'approved' | 'rejected' } }
    'PATCH /api/quest-runs/:id/effects': (u, b, p) => {
      const r = gmRun(u, p.id);
      if (r.status !== 'finished') fail(409, 'decide outcomes once the side quest is finished');
      if (['published', 'cancelled'].includes(find('downtimes', actionOf(r).downtimeId).status)) fail(409, 'this downtime is closed');
      for (const [i, d] of Object.entries(b.decisions || {})) {
        const e = r.effects[Number(i)] || fail(400, `no outcome ${i}`);
        if (!e.gm) fail(400, `${describe(e)} needs no decision`);
        e.status = oneOf(d, ['approved', 'rejected'], 'decision');
      }
      syncAction(r);
      record(u.id, 'quest.decided', { runId: r.id, decisions: b.decisions });
      return runView(u, r);
    },
  };

  return { routes, startRun, blockApproval, apply, abandon, runFor, validAdventureId: (worldId, aid) => { const a = find('adventures', aid); if (a.worldId !== worldId) fail(400, 'adventure belongs to another world'); return a.id; } };
};
