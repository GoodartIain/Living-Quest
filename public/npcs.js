// Milestone 9: GM screen for NPC routines: the campaign clock, where every NPC is now, world events, overrides,
// the profile/schedule/reaction editor and the event history. The server computes and enforces everything.
/* global h, api, run, state, render, field, options, onSubmit */
'use strict';

const npcUi = { campaignId: null, editing: null };

function openNpcs(campaignId) {
  state.npcs = true;
  npcUi.campaignId = campaignId;
  npcUi.editing = null;
  render();
}

function renderNpcs() {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  $app.append(h('section', {}, h('div', { class: 'crumbs' },
    h('button', { class: 'link', onclick: () => { state.npcs = false; render(); } }, `‹ ${state.world.name}`), '›', h('strong', {}, 'NPCs and routines'))), box);
  run(() => drawNpcs(box));
}

async function drawNpcs(box) {
  const w = state.world;
  const data = await api('GET', `/api/worlds/${w.id}/npcs${npcUi.campaignId ? `?campaignId=${npcUi.campaignId}` : ''}`);
  if (!data.campaignId) { box.replaceChildren(h('section', {}, h('p', {}, 'Create a campaign first: NPC routines run on a campaign\'s clock.'))); return; }
  npcUi.campaignId = data.campaignId;
  const cid = data.campaignId;
  const [dt, history] = await Promise.all([api('GET', `/api/campaigns/${cid}/downtime`), api('GET', `/api/campaigns/${cid}/npc-log`)]);
  const act = (fn) => run(async () => { await fn(); await drawNpcs(box); });
  const tick = (body) => act(() => api('POST', `/api/campaigns/${cid}/clock`, body));
  const placeOpts = (sel, extra = []) => [...extra, ...data.locations.map((l) => h('option', { value: l.id, selected: l.id === sel || false }, l.name))];
  const nameOf = (id) => (data.npcs.find((n) => n.id === id) || {}).name || '';
  const reactionNames = [...new Set(data.npcs.flatMap((n) => n.reactions.map((r) => r.on)))];
  box.replaceChildren(h('div', {},
    h('section', {}, h('h2', {}, `${dt.clock.label}, ${dt.clock.time}`),
      data.campaigns.length > 1 && field('Campaign', h('select', { onchange: (e) => { npcUi.campaignId = e.target.value; run(() => drawNpcs(box)); } },
        data.campaigns.map((c) => h('option', { value: c.id, selected: c.id === cid || false }, c.name)))),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:end' },
        h('button', { onclick: () => tick({ advanceMinutes: 60 }) }, '+1 hour'),
        h('button', { onclick: () => tick({ advanceMinutes: 240 }) }, '+4 hours'),
        h('button', { onclick: () => tick({ advanceDays: 1 }) }, '+1 day'),
        h('form', { onsubmit: onSubmit((f) => tick({ until: f.until })) },
          field('Advance until', h('input', { name: 'until', type: 'time', required: true, value: '08:00' })), h('button', {}, 'Go'))),
      h('p', { class: 'muted' }, `NPCs follow routines on this campaign's clock. ${data.campaigns.length > 1 ? 'Scene tokens follow the first campaign.' : ''} Default autonomy for this world: ${w.settings.npcAutonomy}.`)),
    h('section', {}, h('h3', {}, 'World event'),
      h('p', { class: 'muted' }, 'NPCs that are reactive, are inside the place, and have a reaction with this name react now.'),
      h('form', { onsubmit: onSubmit((f, form) => act(async () => {
          const r = await api('POST', `/api/campaigns/${cid}/events`, { kind: f.kind, locationId: f.locationId || null, note: f.note });
          form.reset();
          alert(r.reacted.length ? `Reacted: ${r.reacted.map((x) => `${x.name} (${x.activity})`).join(', ')}` : 'Nobody reacted.');
        })) },
        field('Event', h('input', { name: 'kind', required: true, list: 'npc-events', maxlength: 40 })),
        h('datalist', { id: 'npc-events' }, reactionNames.map((n) => h('option', { value: n }))),
        field('Where (includes places inside it)', h('select', { name: 'locationId' }, placeOpts(null, [h('option', { value: '' }, 'Everywhere')]))),
        field('Note', h('input', { name: 'note', maxlength: 200 })),
        h('button', {}, 'Trigger'))),
    h('section', {}, h('h3', {}, 'Where everyone is'),
      data.npcs.length ? h('table', {}, h('tr', {}, ['NPC', 'Now', 'Autonomy', 'Shown to', ''].map((x) => h('th', { style: 'text-align:left' }, x))),
        data.npcs.map((n) => h('tr', { class: 'npc-row' },
          h('td', {}, h('strong', {}, n.name), n.occupation ? ` · ${n.occupation}` : ''),
          h('td', {}, `${n.now.activity} at ${n.now.place}`, n.now.untilLabel ? ` (until ${n.now.untilLabel}${n.now.source === 'reaction' ? `, ${n.now.cause}` : ', GM'})` : ''),
          h('td', {}, n.autonomy === 'inherit' ? `${n.effectiveAutonomy} (world)` : n.autonomy),
          h('td', {}, n.visibility),
          h('td', {}, h('button', { class: 'link', onclick: () => { npcUi.editing = n.id; run(() => drawNpcs(box)); } }, 'edit'), ' · ',
            h('button', { class: 'link', onclick: () => confirm(`Delete ${n.name}? Their history is kept.`) && act(() => api('DELETE', `/api/npcs/${n.id}`)) }, 'delete')))))
        : h('p', { class: 'muted' }, 'No NPCs yet.'),
      h('button', { onclick: () => { npcUi.editing = 'new'; run(() => drawNpcs(box)); } }, 'New NPC')),
    npcUi.editing && editor(data, npcUi.editing === 'new' ? null : data.npcs.find((n) => n.id === npcUi.editing), act, placeOpts, cid),
    h('section', {}, h('h3', {}, 'Event history'),
      history.length ? h('ul', { class: 'npc-log' }, history.slice(0, 80).map((x) => h('li', {}, h('span', { class: 'muted' }, `Day ${x.day + 1} ${x.clock} · `),
        x.kind === 'event' ? h('strong', {}, `Event: ${x.text}`) : x.text, x.npcId && !nameOf(x.npcId) ? h('span', { class: 'muted' }, ' (deleted)') : '')))
        : h('p', { class: 'muted' }, 'Nothing has happened yet. Advance the clock.'))));
}

function editor(data, n, act, placeOpts, cid) {
  const blank = { name: '', occupation: '', pageId: null, homeLocationId: null, visibility: 'party', autonomy: 'inherit', importance: 'minor', schedule: [], reactions: [] };
  const npc = n || blank;
  const sceneOpts = (locId, sel) => [h('option', { value: '' }, '— no scene —'),
    ...data.scenes.filter((s) => !locId || s.locationId === locId).map((s) => h('option', { value: s.id, selected: s.id === sel || false }, `${s.name} (${s.cols}×${s.rows})`))];
  const time = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const steps = h('div', {});
  const reacts = h('div', {});
  // Each row is a small form-like group; values are read back when saving.
  const stepRow = (s = {}) => h('div', { class: 'npc-step', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:end;border-top:1px solid #8883;padding:4px 0' },
    field('From', h('input', { name: 'from', type: 'time', value: s.from != null ? time(s.from) : '08:00', required: true })),
    field('Days (blank = every day)', h('input', { name: 'days', value: (s.days || []).join(','), size: 8, placeholder: '1,2,3' })),
    field('Place', h('select', { name: 'locationId' }, placeOpts(s.locationId))),
    field('Activity', h('input', { name: 'activity', value: s.activity || '', required: true })),
    field('Scene', h('select', { name: 'sceneId' }, sceneOpts(null, s.sceneId))),
    field('x', h('input', { name: 'x', type: 'number', min: 0, value: s.x ?? 0, size: 2 })),
    field('y', h('input', { name: 'y', type: 'number', min: 0, value: s.y ?? 0, size: 2 })),
    h('button', { type: 'button', class: 'link', onclick: (e) => e.target.closest('.npc-step').remove() }, 'remove'));
  const reactRow = (r = {}) => h('div', { class: 'npc-react', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:end;border-top:1px solid #8883;padding:4px 0' },
    field('On event', h('input', { name: 'on', value: r.on || '', required: true, size: 10 })),
    field('Activity', h('input', { name: 'activity', value: r.activity || '', required: true })),
    field('Goes to', h('select', { name: 'locationId' }, placeOpts(r.locationId, [h('option', { value: 'stay', selected: r.locationId === 'stay' || !r.locationId }, 'stays put'), h('option', { value: 'home', selected: r.locationId === 'home' || false }, 'home')]))),
    field('For minutes', h('input', { name: 'minutes', type: 'number', min: 1, value: r.minutes || 60, size: 4 })),
    field('Afterwards', h('select', { name: 'then' }, options(['resume', 'relocate'], r.then || 'resume'))),
    field('Relocate: work at', h('select', { name: 'from' }, placeOpts(r.relocate && r.relocate.from, [h('option', { value: '' }, '—')]))),
    field('moves to', h('select', { name: 'to' }, placeOpts(r.relocate && r.relocate.to, [h('option', { value: '' }, '—')]))),
    h('button', { type: 'button', class: 'link', onclick: (e) => e.target.closest('.npc-react').remove() }, 'remove'));
  npc.schedule.forEach((s) => steps.append(stepRow(s)));
  npc.reactions.forEach((r) => reacts.append(reactRow(r)));
  const val = (row, name) => row.querySelector(`[name=${name}]`).value;
  const save = (form) => act(async () => {
    const f = Object.fromEntries(new FormData(form));
    const schedule = [...steps.querySelectorAll('.npc-step')].map((row) => ({
      from: val(row, 'from'), days: val(row, 'days').split(',').map((x) => x.trim()).filter(Boolean).map(Number),
      locationId: val(row, 'locationId'), activity: val(row, 'activity'),
      ...(val(row, 'sceneId') && { sceneId: val(row, 'sceneId'), x: +val(row, 'x'), y: +val(row, 'y') }) }));
    const reactions = [...reacts.querySelectorAll('.npc-react')].map((row) => ({
      on: val(row, 'on'), activity: val(row, 'activity'), locationId: val(row, 'locationId'), minutes: +val(row, 'minutes'), then: val(row, 'then'),
      ...(val(row, 'then') === 'relocate' && { relocate: { from: val(row, 'from'), to: val(row, 'to') } }) }));
    const body = { name: f.name, occupation: f.occupation, pageId: f.pageId || null, homeLocationId: f.homeLocationId || null,
      visibility: f.visibility, autonomy: f.autonomy, importance: f.importance, schedule, reactions };
    if (n) await api('PATCH', `/api/npcs/${n.id}`, body); else await api('POST', `/api/worlds/${state.world.id}/npcs`, body);
    npcUi.editing = null;
  });
  return h('section', { class: 'npc-editor' }, h('h3', {}, n ? `Edit ${n.name}` : 'New NPC'),
    h('form', { onsubmit: (e) => { e.preventDefault(); save(e.target); } },
      field('Name', h('input', { name: 'name', value: npc.name, required: true, maxlength: 80 })),
      field('Wiki page', h('select', { name: 'pageId' }, h('option', { value: '' }, '— none —'), data.pages.map((p) => h('option', { value: p.id, selected: p.id === npc.pageId || false }, p.title)))),
      field('Occupation', h('input', { name: 'occupation', value: npc.occupation })),
      field('Home', h('select', { name: 'homeLocationId' }, placeOpts(npc.homeLocationId, [h('option', { value: '' }, '— none —')]))),
      field('Shown to', h('select', { name: 'visibility' }, options(['gm', 'party', 'public'], npc.visibility))),
      field('Autonomy', h('select', { name: 'autonomy' }, options(['inherit', 'static', 'scheduled', 'reactive', 'simulated', 'ai-assisted'], npc.autonomy))),
      field('Importance', h('select', { name: 'importance' }, options(['background', 'minor', 'major'], npc.importance))),
      h('h4', {}, 'Routine'), h('p', { class: 'muted' }, `Each step lasts until the next one. Days are weekday numbers 1–${state.world.settings.calendar.daysPerWeek}. A scene puts a token there.`),
      steps, h('button', { type: 'button', onclick: () => steps.append(stepRow()) }, 'Add step'),
      h('h4', {}, 'Reactions'), h('p', { class: 'muted' }, 'Need "reactive" autonomy or more. "Relocate" moves the routine\'s steps at one place to another, for good.'),
      reacts, h('button', { type: 'button', onclick: () => reacts.append(reactRow()) }, 'Add reaction'),
      h('div', { style: 'margin-top:10px' }, h('button', {}, 'Save NPC'), ' ',
        h('button', { type: 'button', onclick: () => { npcUi.editing = null; render(); } }, 'Cancel'))),
    n && h('form', { onsubmit: onSubmit((f) => act(() => api('POST', `/api/npcs/${n.id}/override`, { campaignId: cid, activity: f.activity, locationId: f.locationId, minutes: +f.minutes,
        ...(f.sceneId && { sceneId: f.sceneId, x: +f.x, y: +f.y }) }))) },
      h('h4', {}, 'Override now (GM)'),
      field('Activity', h('input', { name: 'activity', required: true })),
      field('Place', h('select', { name: 'locationId' }, placeOpts(null))),
      field('Scene', h('select', { name: 'sceneId' }, sceneOpts(null, null))),
      field('x', h('input', { name: 'x', type: 'number', min: 0, value: 0, size: 2 })),
      field('y', h('input', { name: 'y', type: 'number', min: 0, value: 0, size: 2 })),
      field('For minutes', h('input', { name: 'minutes', type: 'number', min: 1, value: 60, size: 4 })),
      h('button', {}, 'Override')));
}
