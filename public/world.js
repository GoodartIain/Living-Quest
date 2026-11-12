// Milestone 11: the World screen. GM: factions and their bounded activities, scheduled happenings, direct changes,
// and the simulation preview → decide → commit loop. Players: visible factions, how they regard the party, rumours.
/* global h, api, run, state, render, field, options, onSubmit */
'use strict';

const worldUi = { campaignId: null, editing: null, days: 14, decisions: {}, preview: null };

function openWorldSim(campaignId) {
  state.worldSim = campaignId;
  Object.assign(worldUi, { campaignId, editing: null, decisions: {}, preview: null });
  render();
}

function renderWorldSim() {
  const c = state.world.campaigns.find((x) => x.id === state.worldSim);
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  $app.append(h('section', {}, h('div', { class: 'crumbs' },
    h('button', { class: 'link', onclick: () => { state.worldSim = null; render(); } }, `‹ ${state.world.name}`), '›', h('strong', {}, `World · ${c.name}`))), box);
  run(() => drawWorldSim(box, c));
}

async function drawWorldSim(box, c) {
  const d = await api('GET', `/api/campaigns/${c.id}/world`);
  const rumours = h('section', {}, h('h2', {}, 'News and rumours'), d.rumours.length
    ? h('ul', {}, d.rumours.map((r) => h('li', {}, h('span', { class: 'muted' }, `${r.when}${r.where ? ` · ${r.where}` : ''}: `), r.text))) : h('p', { class: 'muted' }, 'Nothing heard yet.'));
  if (state.world.role !== 'gm') {
    box.replaceChildren(h('div', {}, h('section', {}, h('h2', {}, 'Factions'), d.factions.length
      ? h('ul', {}, d.factions.map((f) => h('li', {}, h('strong', {}, f.name), f.leader ? ` (led by ${f.leader})` : '', ` · ${f.towardParty} toward you`)))
      : h('p', { class: 'muted' }, 'No known factions.')), rumours));
    return;
  }
  const act = (fn) => run(async () => { await fn(); await drawWorldSim(box, c); });
  const fname = (id) => (id === 'party' ? 'the party' : (d.factions.find((f) => f.id === id) || {}).name || '?');
  const lname = (id) => (d.locations.find((l) => l.id === id) || {}).name || '?';
  box.replaceChildren(h('div', {},
    h('section', {}, h('h2', {}, `Now: ${d.now}`),
      h('form', { onsubmit: onSubmit((f) => act(() => api('PATCH', `/api/worlds/${state.world.id}/simulation`, { majorThreshold: +f.t }))) },
        field('Changes of this size or more are major', h('input', { name: 't', type: 'number', min: 1, max: 100, value: d.majorThreshold, size: 3 })), h('button', {}, 'Save'))),
    simPanel(c, d, act),
    h('section', {}, h('h2', {}, 'Factions'),
      d.factions.length ? h('table', { class: 'factions' }, h('tr', {}, ['Faction', 'Influence', 'Resources', 'Territory', 'Standings', ''].map((x) => h('th', { style: 'text-align:left' }, x))),
        d.factions.map((f) => h('tr', {}, h('td', {}, h('strong', {}, f.name), ` · ${f.visibility}`), h('td', {}, String(f.current.influence)), h('td', {}, String(f.current.resources)),
          h('td', {}, f.current.territory.map(lname).join(', ') || '—'),
          h('td', {}, Object.entries(f.current.standings).map(([k, v]) => `${fname(k)} ${v > 0 ? '+' : ''}${v}`).join(', ') || '—'),
          h('td', {}, h('button', { class: 'link', onclick: () => { worldUi.editing = f.id; act(async () => {}); } }, 'edit')))))
        : h('p', { class: 'muted' }, 'No factions yet.'),
      h('button', { onclick: () => { worldUi.editing = 'new'; act(async () => {}); } }, 'New faction'),
      worldUi.editing && factionEditor(d, worldUi.editing === 'new' ? null : d.factions.find((f) => f.id === worldUi.editing), act)),
    h('section', {}, h('h2', {}, 'Scheduled happenings'),
      d.happenings.length ? h('ul', {}, d.happenings.map((x) => h('li', {}, `${x.when}: `, h('strong', {}, x.label), ` · ${x.significance} · ${x.status} · ${x.effectsText.join('; ')} `,
        x.status === 'scheduled' && h('button', { class: 'link', onclick: () => act(() => api('DELETE', `/api/happenings/${x.id}`)) }, 'cancel')))) : h('p', { class: 'muted' }, 'None.'),
      effectsForm(d, 'Schedule', [field('In days', h('input', { name: 'inDays', type: 'number', min: 0, value: 7, size: 3 })), field('At', h('input', { name: 'at', type: 'time', value: '12:00' })),
        field('Label', h('input', { name: 'label', required: true })), field('Significance', h('select', { name: 'significance' }, options(['routine', 'minor', 'major', 'protected'], 'minor')))],
      (f, effects) => act(() => api('POST', `/api/campaigns/${c.id}/happenings`, { inDays: +f.inDays, at: f.at, label: f.label, significance: f.significance, effects })))),
    h('section', {}, h('h2', {}, 'Change the world now (GM decision)'),
      effectsForm(d, 'Apply now', [field('Why', h('input', { name: 'note', placeholder: 'e.g. the party drove off the bandits', size: 30 }))],
        (f, effects) => act(() => api('POST', `/api/campaigns/${c.id}/world-changes`, { note: f.note, effects })))),
    rumours,
    h('section', {}, h('h2', {}, 'History'), d.history.length ? h('ul', { class: 'world-history' }, d.history.slice(0, 100).map((x) => h('li', {},
      h('span', { class: 'muted' }, `${x.when} · `), x.text, h('span', { class: 'muted' }, ` · ${x.source} · ${x.significance}`)))) : h('p', { class: 'muted' }, 'Nothing has changed yet.'))));
}

// ---- simulation preview -------------------------------------------------------------------------------------
function simPanel(c, d, act) {
  const host = h('section', { class: 'sim' });
  const draw = () => {
    const p = worldUi.preview;
    const preview = () => run(async () => { worldUi.preview = await api('POST', `/api/campaigns/${c.id}/simulate`, { days: worldUi.days, decisions: worldUi.decisions }); draw(); });
    const decide = (dev, v) => { worldUi.decisions[dev.id] = v; preview(); };
    host.replaceChildren(h('div', {}, h('h2', {}, 'Advance the world'),
      h('p', { class: 'muted' }, 'Preview a draft timeline first: nothing changes until you commit. Routine and minor developments are approved unless you reject them; major ones need your decision; protected ones never happen by simulation.'),
      h('form', { onsubmit: (e) => { e.preventDefault(); worldUi.days = +e.target.days.value; worldUi.decisions = {}; preview(); } },
        field('Days', h('input', { name: 'days', type: 'number', min: 1, max: 365, value: worldUi.days, size: 3 })), h('button', {}, 'Preview')),
      p && h('div', {}, h('h3', {}, `Draft: ${p.from} → ${p.to}`),
        p.developments.length ? h('ol', { class: 'devs' }, p.developments.map((dev) => h('li', { class: `dev ${dev.status}`, style: 'margin:8px 0' },
          h('div', {}, h('span', { class: 'muted' }, `${dev.when} · `), h('strong', {}, dev.source), h('span', { class: 'muted' }, ` (${dev.rule})`), ' · ', h('em', {}, dev.significance), ' · ', h('strong', {}, dev.status), dev.reason ? ` · ${dev.reason}` : ''),
          h('ul', {}, dev.effects.map((e) => h('li', {}, e.summary)), dev.reactions.map((r) => h('li', { class: 'muted' }, `reacts: ${r}`))),
          !['blocked', 'skipped'].includes(dev.status) && h('div', {},
            h('button', { class: 'link', 'aria-pressed': String(dev.status === 'approved'), onclick: () => decide(dev, 'approved') }, 'approve'), ' · ',
            h('button', { class: 'link', 'aria-pressed': String(dev.status === 'rejected'), onclick: () => decide(dev, 'rejected') }, 'reject')))))
          : h('p', { class: 'muted' }, 'Nothing happens in this period.'),
        h('h4', {}, 'Factions afterwards'), h('ul', {}, p.factions.map((f) => h('li', {}, `${f.name}: influence ${f.influence}, resources ${f.resources}, territory ${f.territory.join(', ') || '—'}`))),
        h('h4', {}, 'NPCs afterwards'), h('ul', {}, p.npcs.map((n) => h('li', {}, `${n.name}: ${n.activity.toLowerCase()} at ${n.place}`))),
        p.undecided ? h('p', { class: 'note' }, `${p.undecided} major development(s) need your decision before you can commit.`) : null,
        h('button', { class: 'commit', disabled: p.undecided > 0, onclick: () => act(async () => {
          await api('POST', `/api/campaigns/${c.id}/simulate/commit`, { days: p.days, decisions: worldUi.decisions, hash: p.hash });
          worldUi.preview = null; worldUi.decisions = {};
        }) }, `Commit ${p.days} days`))));
  };
  draw();
  return host;
}

// ---- effects editor (activities, happenings, GM changes) ------------------------------------------------------
const EFX = { influence: ['factionId', 'delta'], resources: ['factionId', 'delta'], standing: ['factionId', 'target', 'delta'], territory: ['factionId', 'locationId', 'gain'],
  rumour: ['text', 'locationId', 'visibility'], event: ['eventKind', 'locationId'], npc: ['npcId', 'locationId', 'activity', 'hours'] };
function effectRow(d, e = { kind: 'influence' }, own = false) {
  const fopts = (sel, extra = []) => [...extra, ...d.factions.map((f) => h('option', { value: f.id, selected: f.id === sel || false }, f.name))];
  const row = h('div', { class: 'w-effect', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:end;margin-left:16px' },
    field('Effect', h('select', { name: 'kind', onchange: () => show() }, options(Object.keys(EFX), e.kind))),
    h('span', { 'data-f': 'factionId' }, field('Faction', h('select', { name: 'factionId' }, fopts(e.factionId, own ? [h('option', { value: '' }, 'this faction')] : [])))),
    h('span', { 'data-f': 'target' }, field('Toward', h('select', { name: 'target' }, h('option', { value: 'party', selected: e.target === 'party' }, 'the party'), fopts(e.target)))),
    h('span', { 'data-f': 'delta' }, field('Change', h('input', { name: 'delta', type: 'number', value: e.delta ?? 5, size: 4 }))),
    h('span', { 'data-f': 'locationId' }, field('Place', h('select', { name: 'locationId' }, h('option', { value: '' }, '—'), d.locations.map((l) => h('option', { value: l.id, selected: l.id === e.locationId || false }, l.name))))),
    h('span', { 'data-f': 'gain' }, h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'gain', checked: e.gain !== false }), 'gains (untick: loses)')),
    h('span', { 'data-f': 'text' }, field('Rumour', h('input', { name: 'text', value: e.text || '', size: 30 }))),
    h('span', { 'data-f': 'visibility' }, field('Heard by', h('select', { name: 'visibility' }, options(['party', 'public', 'gm'], e.visibility || 'party')))),
    h('span', { 'data-f': 'eventKind' }, field('Event', h('input', { name: 'eventKind', value: e.eventKind || '', size: 10 }))),
    h('span', { 'data-f': 'npcId' }, field('NPC', h('select', { name: 'npcId' }, d.npcs.map((n) => h('option', { value: n.id, selected: n.id === e.npcId || false }, n.name))))),
    h('span', { 'data-f': 'activity' }, field('Doing', h('input', { name: 'activity', value: e.activity || '' }))),
    h('span', { 'data-f': 'hours' }, field('For hours', h('input', { name: 'hours', type: 'number', min: 1, value: e.minutes ? e.minutes / 60 : 24, size: 4 }))),
    h('button', { type: 'button', class: 'link', onclick: () => row.remove() }, 'remove'));
  const show = () => { const k = row.querySelector('[name=kind]').value; row.querySelectorAll('[data-f]').forEach((x) => { x.hidden = !EFX[k].includes(x.dataset.f); }); };
  show();
  return row;
}
function readEffects(host) {
  return [...host.querySelectorAll(':scope > .w-effect, :scope .w-effects > .w-effect')].map((r) => {
    const v = (n) => r.querySelector(`[name=${n}]`);
    const kind = v('kind').value;
    const e = { kind };
    for (const f of EFX[kind]) {
      if (f === 'delta') e.delta = +v('delta').value;
      else if (f === 'gain') e.gain = v('gain').checked;
      else if (f === 'hours') e.minutes = Math.round(+v('hours').value * 60);
      else if (v(f).value !== '') e[f] = v(f).value;
    }
    return e;
  });
}
function effectsForm(d, label, extra, submit) {
  const list = h('div', { class: 'w-effects' }, effectRow(d));
  return h('form', { onsubmit: (e) => { e.preventDefault(); submit(Object.fromEntries(new FormData(e.target)), readEffects(list)); } },
    extra, list, h('button', { type: 'button', class: 'link', onclick: () => list.append(effectRow(d)) }, '+ effect'), ' ', h('button', {}, label));
}

function factionEditor(d, f, act) {
  const blank = { name: '', visibility: 'party', influence: 50, resources: 100, territory: [], standings: {}, goals: '', leader: '', activities: [] };
  const x = f || blank;
  const acts = h('div', {});
  const actRow = (a = { name: '', every: 7, chance: 100, cost: 0, significance: 'minor', effects: [{ kind: 'influence', delta: 5 }] }) => {
    const effects = h('div', { class: 'w-effects' }, a.effects.map((e) => effectRow(d, { ...e, factionId: e.factionId === (f && f.id) ? '' : e.factionId }, true)));
    const box = h('fieldset', { class: 'w-activity', 'data-id': a.id || '' }, h('legend', {}, 'Activity'),
      field('Name', h('input', { name: 'aname', value: a.name, required: true })),
      field('Every (days)', h('input', { name: 'every', type: 'number', min: 1, value: a.every, size: 3 })),
      field('Chance %', h('input', { name: 'chance', type: 'number', min: 1, max: 100, value: a.chance, size: 3 })),
      field('Costs resources', h('input', { name: 'cost', type: 'number', min: 0, value: a.cost, size: 4 })),
      field('Significance', h('select', { name: 'sig' }, options(['routine', 'minor', 'major', 'protected'], a.significance))),
      effects, h('button', { type: 'button', class: 'link', onclick: () => effects.append(effectRow(d, { kind: 'influence' }, true)) }, '+ effect'), ' ',
      h('button', { type: 'button', class: 'link', onclick: () => box.remove() }, 'remove activity'));
    return box;
  };
  x.activities.forEach((a) => acts.append(actRow(a)));
  const others = d.factions.filter((o) => !f || o.id !== f.id);
  return h('section', { class: 'faction-editor' }, h('h3', {}, f ? `Edit ${f.name}` : 'New faction'),
    h('form', { onsubmit: (e) => { e.preventDefault(); const form = e.target; act(async () => {
        const v = Object.fromEntries(new FormData(form));
        const body = { name: v.name, visibility: v.visibility, influence: +v.influence, resources: +v.resources, leader: v.leader, goals: v.goals,
          territory: [...form.querySelectorAll('input[name=territory]:checked')].map((i) => i.value),
          standings: Object.fromEntries([...form.querySelectorAll('input[data-standing]')].filter((i) => i.value !== '' && +i.value !== 0).map((i) => [i.dataset.standing, +i.value])),
          activities: [...acts.querySelectorAll('.w-activity')].map((b) => ({ ...(b.dataset.id && { id: b.dataset.id }), name: b.querySelector('[name=aname]').value, every: +b.querySelector('[name=every]').value,
            chance: +b.querySelector('[name=chance]').value, cost: +b.querySelector('[name=cost]').value, significance: b.querySelector('[name=sig]').value, effects: readEffects(b) })) };
        if (f) await api('PATCH', `/api/factions/${f.id}`, body); else await api('POST', `/api/worlds/${state.world.id}/factions`, body);
        worldUi.editing = null;
      }); } },
      field('Name', h('input', { name: 'name', value: x.name, required: true })),
      field('Shown to', h('select', { name: 'visibility' }, options(['gm', 'party', 'public'], x.visibility))),
      field('Leader', h('input', { name: 'leader', value: x.leader })),
      field('Starting influence (0–100)', h('input', { name: 'influence', type: 'number', min: 0, max: 100, value: x.influence, size: 3 })),
      field('Starting resources', h('input', { name: 'resources', type: 'number', min: 0, value: x.resources, size: 5 })),
      h('label', { style: 'width:100%' }, 'Goals (GM only)', h('textarea', { name: 'goals', rows: 2 }, x.goals)),
      h('fieldset', {}, h('legend', {}, 'Starting territory'), d.locations.map((l) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'territory', value: l.id, checked: x.territory.includes(l.id) }), l.name))),
      h('fieldset', {}, h('legend', {}, 'Starting standings (−100 hostile … 100 allied)'),
        [['party', 'the party'], ...others.map((o) => [o.id, o.name])].map(([k, n]) => field(n, h('input', { type: 'number', min: -100, max: 100, 'data-standing': k, value: x.standings[k] ?? 0, size: 4 })))),
      h('h4', {}, 'Activities (what the faction does as time passes)'), acts,
      h('button', { type: 'button', onclick: () => acts.append(actRow()) }, 'Add activity'), ' ',
      h('button', {}, 'Save faction'), ' ', h('button', { type: 'button', onclick: () => { worldUi.editing = null; act(async () => {}); } }, 'Cancel')));
}
