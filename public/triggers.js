// Milestone 10: interaction triggers on the 2D board. Players use a marker next to their token; the GM places and
// manages them. The server checks adjacency and runs the actions; this only shows the result.
/* global h, api, run, state, field, options, onSubmit */
'use strict';

function useTrigger(t) {
  if (!t) return;
  run(async () => {
    const r = await api('POST', `/api/triggers/${t.id}/interact`);
    const out = document.getElementById('trigout');
    if (!out) return;
    out.hidden = false;
    out.replaceChildren(h('strong', {}, `${r.name}: `), r.text || 'Nothing happens.',
      r.revealed ? ` (${r.revealed} squares revealed)` : '', r.shown ? ` ${r.shown} appears.` : '');
  });
}

function placeTrigger(scene, cell) {
  const form = document.getElementById('trigform');
  if (!form) return;
  const f = Object.fromEntries(new FormData(form));
  const rect = f.reveal.split(',').map((x) => Number(x.trim()));
  run(() => api('POST', `/api/scenes/${scene.id}/triggers`, {
    name: f.name || 'Lever', text: f.text, x: cell.x, y: cell.y, visibility: f.visibility, once: !!f.once,
    revealFog: rect.length === 4 && rect.every(Number.isInteger) ? { x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3] } : null,
    showTokenId: f.showTokenId || null, event: f.event.trim() ? { kind: f.event.trim() } : null,
  }));
}

function triggerTools(v) {
  const list = v.triggers || [];
  return h('div', {}, h('h3', {}, 'Interaction triggers'),
    h('p', { class: 'muted' }, 'Fill this in, choose "Place trigger" and click a square. Players use it from a square next to it.'),
    h('form', { id: 'trigform', onsubmit: (e) => e.preventDefault() },
      field('Name', h('input', { name: 'name', value: 'Lever', maxlength: 60 })),
      field('Shown to', h('select', { name: 'visibility' }, options(['gm', 'party', 'public'], 'party'))),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'once' }), 'Only once'),
      h('label', { style: 'width:100%' }, 'Text when used', h('textarea', { name: 'text', rows: 2 })),
      field('Reveal fog (x0,y0,x1,y1)', h('input', { name: 'reveal', placeholder: 'e.g. 6,4,9,7', size: 10 })),
      field('Reveal hidden token', h('select', { name: 'showTokenId' }, h('option', { value: '' }, '—'),
        v.tokens.filter((t) => t.visibility === 'gm').map((t) => h('option', { value: t.id }, t.name)))),
      field('World event (NPCs react)', h('input', { name: 'event', placeholder: 'e.g. alarm', maxlength: 40 }))),
    list.length > 0 && h('ul', {}, list.map((t) => h('li', {}, `${t.name} at ${t.x},${t.y} [${t.visibility}${t.once ? ', once' : ''}${t.usedAt ? ', used' : ''}] `,
      [t.revealFog && 'reveals fog', t.showTokenId && 'reveals a token', t.event && `event "${t.event.kind}"`].filter(Boolean).join(', '), ' ',
      t.usedAt && h('button', { class: 'link', onclick: () => run(() => api('PATCH', `/api/triggers/${t.id}`, { reset: true })) }, 'reset'), ' ',
      h('button', { class: 'link', onclick: () => confirm(`Delete ${t.name}?`) && run(() => api('DELETE', `/api/triggers/${t.id}`)) }, 'delete')))));
}
