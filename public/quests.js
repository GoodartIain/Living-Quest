// Milestone 10: quest log (everyone in the campaign, filtered by the server) and, for the GM, the side-quest
// adventure editor. Adventures are played from the downtime screen (see runPanel below).
/* global h, api, run, state, render, field, options, onSubmit */
'use strict';

function openQuests(campaignId) {
  state.quests = campaignId;
  render();
}

function renderQuests() {
  const c = state.world.campaigns.find((x) => x.id === state.quests);
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  $app.append(h('section', {}, h('div', { class: 'crumbs' },
    h('button', { class: 'link', onclick: () => { state.quests = null; render(); } }, `‹ ${state.world.name}`), '›', h('strong', {}, `Quests · ${c.name}`))), box);
  run(() => drawQuests(box, c));
}

async function drawQuests(box, c) {
  const gm = state.world.role === 'gm';
  const [list, adventures, chars] = await Promise.all([api('GET', `/api/campaigns/${c.id}/quests`),
    gm ? api('GET', `/api/worlds/${state.world.id}/adventures`) : [], gm ? api('GET', `/api/campaigns/${c.id}/characters`) : []]);
  const act = (fn) => run(async () => { await fn(); await drawQuests(box, c); });
  const patch = (q, body) => act(() => api('PATCH', `/api/quests/${q.id}`, body));
  box.replaceChildren(h('div', {},
    h('section', {}, h('h2', {}, 'Quest log'),
      list.length ? h('ul', { style: 'list-style:none;padding:0' }, list.map((q) => h('li', { class: 'quest', style: 'margin:10px 0' },
        h('strong', {}, q.title), ` · ${q.kind}${q.characterName ? ` (${q.characterName})` : ''} · `, h('em', {}, q.status),
        gm && q.visibility === 'gm' && h('span', { class: 'muted' }, ' · hidden from players'),
        q.description && h('div', {}, q.description),
        q.objectives.length > 0 && h('ul', {}, q.objectives.map((o) => h('li', {},
          gm ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: o.done, onchange: (e) => patch(q, { objectives: q.objectives.map((x) => (x.id === o.id ? { ...x, done: e.target.checked } : x)) }) }), o.text)
            : `${o.done ? '☑' : '☐'} ${o.text}`))),
        gm && q.notes && h('div', { class: 'note' }, `GM: ${q.notes}`),
        gm && h('div', {}, h('select', { 'aria-label': `${q.title} status`, onchange: (e) => patch(q, { status: e.target.value }) }, options(['active', 'completed', 'failed'], q.status)), ' ',
          h('select', { 'aria-label': `${q.title} shown to`, onchange: (e) => patch(q, { visibility: e.target.value }) }, options(['gm', 'party'], q.visibility))))))
        : h('p', { class: 'muted' }, 'No quests yet.'),
      gm && h('form', { onsubmit: onSubmit((f, form) => act(async () => {
          await api('POST', `/api/campaigns/${c.id}/quests`, { title: f.title, kind: f.kind, visibility: f.visibility, description: f.description, notes: f.notes,
            characterId: f.characterId || null, objectives: f.objectives.split('\n').map((x) => x.trim()).filter(Boolean).map((text) => ({ text })) });
          form.reset();
        })) },
        h('h3', {}, 'New quest'),
        field('Title', h('input', { name: 'title', required: true, maxlength: 120 })),
        field('Kind', h('select', { name: 'kind' }, options(['main', 'optional', 'personal', 'downtime', 'faction'], 'optional'))),
        field('For character (personal)', h('select', { name: 'characterId' }, h('option', { value: '' }, '— party —'), chars.map((ch) => h('option', { value: ch.id }, ch.name)))),
        field('Shown to', h('select', { name: 'visibility' }, options(['party', 'gm'], 'party'))),
        h('label', { style: 'width:100%' }, 'Description', h('textarea', { name: 'description', rows: 2 })),
        h('label', { style: 'width:100%' }, 'Objectives (one per line)', h('textarea', { name: 'objectives', rows: 3 })),
        h('label', { style: 'width:100%' }, 'GM notes', h('textarea', { name: 'notes', rows: 2 })),
        h('button', {}, 'Add quest'))),
    gm && adventureSection(adventures, list, act)));
}

// ---- adventure editor (GM) ------------------------------------------------------------------------------------
const advUi = { editing: null };
const EFFECT_FIELDS = { gp: ['amount'], xp: ['amount'], item: ['value'], journal: ['value'], event: ['value', 'locationId'], discover: ['locationId'], reveal: ['pageId'], quest: ['questObj', 'questStatus', 'reveal'] };

function adventureSection(adventures, quests, act) {
  return h('section', {}, h('h2', {}, 'Side-quest adventures'),
    h('p', { class: 'muted' }, 'Branching adventures a player plays alone during downtime. Add one to a downtime as a custom activity. Rewards within the limits apply by themselves; major items, gold or XP past the limits, revealed lore and world events wait for your approval.'),
    adventures.length ? h('ul', {}, adventures.map((a) => h('li', {}, h('strong', {}, a.title), ` · ${Object.keys(a.nodes).length} nodes · limits ${a.maxGp} gp, ${a.maxXp} XP `,
      h('button', { class: 'link', onclick: () => { advUi.editing = a.id; act(async () => {}); } }, 'edit')))) : h('p', { class: 'muted' }, 'None yet.'),
    h('button', { onclick: () => { advUi.editing = 'new'; act(async () => {}); } }, 'New adventure'),
    advUi.editing && advEditor(advUi.editing === 'new' ? null : adventures.find((a) => a.id === advUi.editing), quests, act));
}

function advEditor(a, quests, act) {
  const start = a || { title: '', summary: '', maxGp: 50, maxXp: 100, start: 'start', nodes: { start: { text: '', choices: [], effects: [], outcome: 'success' } } };
  const locations = []; // filled lazily from the NPC endpoint, which lists places and pages for the GM
  const pages = [];
  const nodesBox = h('div', {});
  const sel = (name, list, value, blank) => h('select', { name, 'data-want': value || '' }, blank && h('option', { value: '' }, blank), list.map(([v, l]) => h('option', { value: v, selected: v === value || false }, l)));
  const effectRow = (e = { type: 'gp' }) => {
    const row = h('div', { class: 'adv-effect', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:end;margin-left:16px' },
      field('Effect', h('select', { name: 'type', onchange: () => show() }, options(Object.keys(EFFECT_FIELDS), e.type))),
      h('span', { 'data-f': 'amount' }, field('Amount', h('input', { name: 'amount', type: 'number', min: 1, value: e.amount || 10, size: 4 }))),
      h('span', { 'data-f': 'value' }, field('Name / text / event', h('input', { name: 'value', value: e.name || e.text || e.kind || '' }))),
      h('span', { 'data-f': 'locationId' }, field('Place', sel('locationId', locations, e.locationId, '— anywhere —'))),
      h('span', { 'data-f': 'pageId' }, field('Wiki page', sel('pageId', pages, e.pageId))),
      h('span', { 'data-f': 'questObj' }, field('Quest / objective', sel('questObj', quests.flatMap((q) => [[`${q.id}:`, q.title], ...q.objectives.map((o) => [`${q.id}:${o.id}`, `${q.title} › ${o.text}`])]),
        e.questId ? `${e.questId}:${e.objectiveId || ''}` : null))),
      h('span', { 'data-f': 'questStatus' }, field('Set status', sel('questStatus', [['completed', 'completed'], ['failed', 'failed'], ['active', 'active']], e.questStatus, '— unchanged —'))),
      h('span', { 'data-f': 'reveal' }, h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'reveal', checked: e.reveal || false }), 'reveal quest')),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'major', checked: e.major || false }), 'needs GM approval'),
      h('button', { type: 'button', class: 'link', onclick: () => row.remove() }, 'remove'));
    const show = () => { const t = row.querySelector('[name=type]').value; row.querySelectorAll('[data-f]').forEach((x) => { x.hidden = !EFFECT_FIELDS[t].includes(x.dataset.f); }); };
    show();
    return row;
  };
  const choiceRow = (c = {}) => h('div', { class: 'adv-choice', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:end;margin-left:16px' },
    field('Choice', h('input', { name: 'label', value: c.label || '', required: true })),
    field('Goes to node', h('input', { name: 'to', value: c.to || '', size: 8, list: 'adv-nodes', placeholder: 'or use a check' })),
    field('Check (e.g. skill:Stealth)', h('input', { name: 'check', value: c.check || '', size: 14 })),
    field('DC', h('input', { name: 'dc', type: 'number', min: 1, value: c.dc || 12, size: 3 })),
    field('Success →', h('input', { name: 'success', value: c.success || '', size: 8, list: 'adv-nodes' })),
    field('Failure →', h('input', { name: 'failure', value: c.failure || '', size: 8, list: 'adv-nodes' })),
    h('button', { type: 'button', class: 'link', onclick: (ev) => ev.target.closest('.adv-choice').remove() }, 'remove'));
  const nodeBlock = (key, n = { text: '', choices: [], effects: [], outcome: 'success' }) => {
    const choices = h('div', {}, n.choices.map((c) => choiceRow(c)));
    const effects = h('div', {}, n.effects.map((e) => effectRow(e)));
    const block = h('fieldset', { class: 'adv-node' }, h('legend', {}, 'Node'),
      field('Name', h('input', { name: 'key', value: key, required: true, size: 12, pattern: '[a-z0-9-]{1,30}' })),
      field('If it ends here', h('select', { name: 'outcome' }, options(['success', 'failure'], n.outcome || 'success'))),
      h('label', { style: 'width:100%' }, 'Text the player reads', h('textarea', { name: 'text', rows: 3 }, n.text)),
      h('div', { style: 'width:100%' }, h('strong', {}, 'Effects on arrival'), effects, h('button', { type: 'button', class: 'link', onclick: () => effects.append(effectRow()) }, '+ effect')),
      h('div', { style: 'width:100%' }, h('strong', {}, 'Choices (none = an ending)'), choices, h('button', { type: 'button', class: 'link', onclick: () => choices.append(choiceRow()) }, '+ choice')),
      h('button', { type: 'button', class: 'link', onclick: () => block.remove() }, 'remove node'));
    return block;
  };
  for (const [k, n] of Object.entries(start.nodes)) nodesBox.append(nodeBlock(k, n));
  const v = (el, name) => el.querySelector(`[name=${name}]`);
  const collect = (form) => {
    const nodes = {};
    for (const b of nodesBox.querySelectorAll('.adv-node')) {
      nodes[v(b, 'key').value.trim()] = {
        text: v(b, 'text').value, outcome: v(b, 'outcome').value,
        choices: [...b.querySelectorAll('.adv-choice')].map((r) => (v(r, 'check').value.trim()
          ? { label: v(r, 'label').value, check: v(r, 'check').value.trim(), dc: +v(r, 'dc').value, success: v(r, 'success').value.trim(), failure: v(r, 'failure').value.trim() }
          : { label: v(r, 'label').value, to: v(r, 'to').value.trim() })),
        effects: [...b.querySelectorAll('.adv-effect')].map((r) => {
          const type = v(r, 'type').value;
          const e = { type, major: v(r, 'major').checked };
          if (type === 'gp' || type === 'xp') e.amount = +v(r, 'amount').value;
          if (type === 'item') e.name = v(r, 'value').value;
          if (type === 'journal') e.text = v(r, 'value').value;
          if (type === 'event') { e.kind = v(r, 'value').value; e.locationId = v(r, 'locationId').value || null; }
          if (type === 'discover') e.locationId = v(r, 'locationId').value;
          if (type === 'reveal') e.pageId = v(r, 'pageId').value;
          if (type === 'quest') { const [q, o] = v(r, 'questObj').value.split(':'); e.questId = q; if (o) e.objectiveId = o; if (v(r, 'questStatus').value) e.questStatus = v(r, 'questStatus').value; e.reveal = v(r, 'reveal').checked; }
          return e;
        }),
      };
    }
    const f = Object.fromEntries(new FormData(form));
    return { title: f.title, summary: f.summary, maxGp: +f.maxGp, maxXp: +f.maxXp, start: f.start.trim(), nodes };
  };
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); act(async () => {
      const body = collect(e.target);
      if (a) await api('PATCH', `/api/adventures/${a.id}`, body); else await api('POST', `/api/worlds/${state.world.id}/adventures`, body);
      advUi.editing = null;
    }); } },
    field('Title', h('input', { name: 'title', value: start.title, required: true })),
    field('First node', h('input', { name: 'start', value: start.start, size: 10, list: 'adv-nodes' })),
    field('Gold limit', h('input', { name: 'maxGp', type: 'number', min: 0, value: start.maxGp, size: 5 })),
    field('XP limit', h('input', { name: 'maxXp', type: 'number', min: 0, value: start.maxXp, size: 5 })),
    h('label', { style: 'width:100%' }, 'Summary (players see it)', h('textarea', { name: 'summary', rows: 2 }, start.summary)),
    h('datalist', { id: 'adv-nodes' }, Object.keys(start.nodes).map((k) => h('option', { value: k }))),
    nodesBox,
    h('button', { type: 'button', onclick: () => nodesBox.append(nodeBlock(`node-${nodesBox.children.length + 1}`)) }, 'Add node'), ' ',
    h('button', {}, 'Save adventure'), ' ',
    h('button', { type: 'button', onclick: () => { advUi.editing = null; act(async () => {}); } }, 'Cancel'));
  // Places and pages for the pickers, from the GM-only NPC listing.
  api('GET', `/api/worlds/${state.world.id}/npcs`).then((d) => {
    locations.push(...d.locations.map((l) => [l.id, l.name]));
    pages.push(...(d.allPages || []).map((p) => [p.id, p.title]));
    // keep each saved choice: the options arrive after the rows were drawn
    for (const s of form.querySelectorAll('select[name=locationId]')) s.append(...locations.map(([id, name]) => h('option', { value: id, selected: id === s.dataset.want || false }, name)));
    for (const s of form.querySelectorAll('select[name=pageId]')) s.append(...pages.map(([id, t]) => h('option', { value: id, selected: id === s.dataset.want || false }, t)));
  }).catch(() => {});
  return h('section', { class: 'adv-editor' }, h('h3', {}, a ? `Edit ${a.title}` : 'New adventure'), form);
}

// ---- playing and reviewing a run (used by the downtime screen) ---------------------------------------------
async function runPanel(host, runId, after) {
  const r = await api('GET', `/api/quest-runs/${runId}`);
  const gm = state.world.role === 'gm';
  const act = (fn) => run(async () => { await fn(); await runPanel(host, runId, after); if (after) after(); });
  host.replaceChildren(h('section', { class: 'run-panel' }, h('h3', {}, `Side quest: ${r.title}`), r.summary && h('p', { class: 'muted' }, r.summary),
    r.path.length > 0 && h('ol', { class: 'run-path' }, r.path.map((x) => h('li', {}, h('div', { class: 'muted' }, x.text), h('div', {}, `→ ${x.choice}`,
      x.roll ? ` (${x.roll.formula} = ${x.roll.total} vs DC ${x.roll.dc}: ${x.roll.success ? 'success' : 'failure'})` : ''), x.answer && h('div', { class: 'note' }, `GM: ${x.answer}`)))),
    h('div', { class: 'run-node', style: 'padding:8px;border-left:3px solid #c9a227;margin:8px 0' }, r.node.text),
    r.status === 'running' && !gm && h('div', {}, r.node.choices.map((c) => h('button', { onclick: () => act(() => api('POST', `/api/quest-runs/${runId}/choose`, { index: c.i })) },
      c.label + (c.check ? ` (${c.check})` : ''))),
      h('form', { onsubmit: onSubmit((f) => act(() => api('POST', `/api/quest-runs/${runId}/ask`, { text: f.text }))) },
        field('Want to do something else? Ask the GM', h('input', { name: 'text', required: true, size: 40 })), h('button', {}, 'Ask'))),
    r.status === 'waiting' && h('p', { class: 'note' }, `Waiting for the GM: "${r.question}"`),
    r.status === 'waiting' && gm && h('form', { onsubmit: onSubmit((f) => act(() => api('POST', `/api/quest-runs/${runId}/answer`, { text: f.text, ...(f.to.startsWith('end:') ? { end: f.to.slice(4) } : { to: f.to }) }))) },
      field('Answer', h('input', { name: 'text', required: true, size: 40 })),
      field('Then', h('select', { name: 'to' }, r.nodes.map((k) => h('option', { value: k }, `continue at ${k}`)), h('option', { value: 'end:success' }, 'end: success'), h('option', { value: 'end:failure' }, 'end: failure'))),
      h('button', {}, 'Answer')),
    r.status === 'finished' && h('p', {}, h('strong', {}, `Finished: ${r.outcome}`)),
    r.status === 'abandoned' && h('p', { class: 'muted' }, 'This side quest was closed.'),
    r.effects.length > 0 && h('div', {}, h('h4', {}, 'Outcomes'), h('ul', {}, r.effects.map((e) => h('li', { class: `effect ${e.status}` }, `${e.label} · `,
      h('em', {}, e.status === 'auto' ? 'applies on publish' : e.status === 'pending' ? (r.status === 'finished' ? 'waiting for the GM' : e.gm ? 'needs GM approval' : 'applies on publish if within the limits') : e.status),
      gm && e.gm && r.status === 'finished' && [' ', h('button', { class: 'link', onclick: () => act(() => api('PATCH', `/api/quest-runs/${runId}/effects`, { decisions: { [e.i]: 'approved' } })) }, 'approve'), ' ',
        h('button', { class: 'link', onclick: () => act(() => api('PATCH', `/api/quest-runs/${runId}/effects`, { decisions: { [e.i]: 'rejected' } })) }, 'reject')]))))));
}
