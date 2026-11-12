// Milestone 8: campaign clock and downtime. Players book activities for their characters on specific days; the GM
// decides them and publishes once. The server enforces every rule; this screen only shows and submits.
/* global h, api, run, state, render, field, options, onSubmit */
'use strict';

function openDowntime(campaignId) {
  state.downtime = campaignId;
  render();
}

async function renderDowntime() {
  const c = state.world.campaigns.find((x) => x.id === state.downtime);
  const box = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  $app.append(h('section', {}, h('div', { class: 'crumbs' },
    h('button', { class: 'link', onclick: () => { state.downtime = null; render(); } }, `‹ ${state.world.name}`), '›', h('strong', {}, `Downtime · ${c.name}`))),
    h('div', { id: 'run-host' }), box); // the side-quest panel stays open while the lists below redraw
  const reload = () => run(() => drawDowntime(box, c));
  box.reload = reload;
  reload();
}

async function drawDowntime(box, c) {
  const v = await api('GET', `/api/campaigns/${c.id}/downtime`);
  if (v.gm) v.adventures = await api('GET', `/api/worlds/${state.world.id}/adventures`);
  const gm = v.gm;
  const act = (fn) => run(async () => { await fn(); await drawDowntime(box, c); });
  const w = v.windows.find((x) => x.status === 'open' || x.status === 'paused');
  const past = v.windows.filter((x) => x.status === 'published').reverse();
  const dayOf = (day) => (w ? day - w.startDay + 1 : day);
  box.replaceChildren(h('div', {},
    h('section', {}, h('h2', {}, `Today: ${v.clock.label}, ${v.clock.time}`),
      h('p', { class: 'muted' }, `Calendar: ${v.calendar.daysPerWeek}-day weeks, ${v.calendar.daysPerMonth}-day months, ${v.calendar.monthsPerYear} months a year. In-game time only moves when the GM advances it or publishes downtime.`),
      gm && !w && h('form', { onsubmit: onSubmit((f) => act(() => api('POST', `/api/campaigns/${c.id}/clock`, { advanceDays: +f.days }))) },
        field('Advance the clock by days', h('input', { name: 'days', type: 'number', min: 1, value: 1, size: 4 })), h('button', {}, 'Advance')),
      gm && h('details', {}, h('summary', {}, 'Calendar settings'),
        h('form', { onsubmit: onSubmit((f) => act(() => api('PATCH', `/api/worlds/${state.world.id}/calendar`, {
            daysPerWeek: +f.daysPerWeek, daysPerMonth: +f.daysPerMonth, monthsPerYear: +f.monthsPerYear,
            ...(f.monthNames.trim() && { monthNames: f.monthNames.split(',').map((x) => x.trim()) }) }))) },
          field('Days per week', h('input', { name: 'daysPerWeek', type: 'number', min: 1, value: v.calendar.daysPerWeek, size: 3 })),
          field('Days per month', h('input', { name: 'daysPerMonth', type: 'number', min: 1, value: v.calendar.daysPerMonth, size: 3 })),
          field('Months per year', h('input', { name: 'monthsPerYear', type: 'number', min: 1, value: v.calendar.monthsPerYear, size: 3 })),
          field('Month names (comma separated, optional)', h('input', { name: 'monthNames', value: (v.calendar.monthNames || []).join(', ') })),
          h('button', {}, 'Save calendar')))),
    w ? windowPanel(v, w, c, gm, act, dayOf) : gm ? createPanel(v, c, act) : h('section', {}, h('p', { class: 'muted' }, 'No downtime is running. The GM will open it between adventures.')),
    past.length > 0 && h('section', {}, h('h2', {}, 'Downtime reports'), past.map((x) => reportOf(x)))));
}

function createPanel(v, c, act) {
  return h('section', {}, h('h2', {}, 'Start downtime'),
    h('form', { onsubmit: onSubmit((f, form) => act(() => {
        const keys = [...form.querySelectorAll('input[name=activity]:checked')].map((i) => i.value);
        const activities = keys.map((k) => v.templates.find((t) => t.key === k));
        const adv = f.adventureId && v.adventures.find((a) => a.id === f.adventureId);
        if (f.customName.trim() || adv) activities.push({ key: 'custom-' + Date.now().toString(36), name: f.customName.trim() || adv.title, days: +f.customDays, resolution: 'manual',
          gpCost: +f.customCost || 0, rewardItem: f.customItem.trim(), repeatable: true, ...(adv && { adventureId: adv.id }) });
        return api('POST', `/api/campaigns/${c.id}/downtime`, { duration: +f.duration, unit: f.unit, deadline: f.deadline || null, activities });
      })) },
      field('Length', h('input', { name: 'duration', type: 'number', min: 1, value: 3, size: 3 })),
      field('Unit', h('select', { name: 'unit' }, options(['days', 'weeks', 'months'], 'weeks'))),
      field('Players submit by (real time, optional)', h('input', { name: 'deadline', type: 'datetime-local' })),
      h('fieldset', {}, h('legend', {}, 'Allowed activities'), v.templates.map((t) => h('label', { class: 'inline' },
        h('input', { type: 'checkbox', name: 'activity', value: t.key, checked: true }),
        `${t.name} (${t.days} d, ${t.resolution}${t.skill ? `, ${t.skill} DC ${t.dc}` : ''}${t.rewardGp ? `, earns ${t.rewardGp} gp` : ''})`))),
      h('fieldset', {}, h('legend', {}, 'Custom activity (optional, GM-decided)'),
        field('Name', h('input', { name: 'customName', placeholder: 'e.g. Rent the master forge' })),
        field('Days', h('input', { name: 'customDays', type: 'number', min: 1, value: 5, size: 3 })),
        field('Costs gp', h('input', { name: 'customCost', type: 'number', min: 0, value: 0, size: 4 })),
        field('Reward item', h('input', { name: 'customItem' })),
        field('Or a side-quest adventure', h('select', { name: 'adventureId' }, h('option', { value: '' }, '— none —'), v.adventures.map((a) => h('option', { value: a.id }, a.title))))),
      h('button', {}, 'Open downtime')));
}

const STATUS = { proposed: 'waiting for GM', resolved: 'rolled, waiting for GM', conflicted: 'conflict: GM decides', approved: 'approved', rejected: 'rejected', cancelled: 'cancelled' };

function windowPanel(v, w, c, gm, act, dayOf) {
  const length = w.endDay - w.startDay;
  const actName = (k) => (w.activities.find((x) => x.key === k) || {}).name || k;
  const open = w.actions.filter((a) => ['proposed', 'resolved', 'conflicted'].includes(a.status)).length;
  // A simple calendar strip per character: one cell per day, filled where an activity is booked.
  const strip = (ch) => {
    const mine = w.actions.filter((a) => a.characterId === ch.id && !['rejected', 'cancelled'].includes(a.status));
    return h('div', { class: 'dt-strip', role: 'img', 'aria-label': `${ch.name}: ${mine.map((a) => `${actName(a.activity)} days ${dayOf(a.startDay)}–${dayOf(a.startDay) + a.days - 1}`).join('; ') || 'nothing booked'}` },
      Array.from({ length }, (_, i) => {
        const a = mine.find((x) => w.startDay + i >= x.startDay && w.startDay + i < x.startDay + x.days);
        return h('span', { class: a ? `on ${a.status}` : '', title: a ? `Day ${i + 1}: ${actName(a.activity)}` : `Day ${i + 1}: free` });
      }));
  };
  return h('div', {},
    h('section', {}, h('h2', {}, `Downtime: ${w.startLabel} to ${w.endLabel} (${length} days)${w.status === 'paused' ? ' · PAUSED' : ''}`),
      w.deadline && h('p', {}, `Submit by ${new Date(w.deadline).toLocaleString()}.`),
      v.bookable.map((ch) => h('div', { style: 'margin:6px 0' }, h('strong', {}, ch.name), ` · ${ch.gp} gp`, strip(ch))),
      gm && h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:end' },
        h('button', { onclick: () => act(() => api('PATCH', `/api/downtime/${w.id}`, { status: w.status === 'paused' ? 'open' : 'paused' })) }, w.status === 'paused' ? 'Resume' : 'Pause'),
        h('form', { onsubmit: onSubmit((f) => act(() => api('PATCH', `/api/downtime/${w.id}`, { endDay: w.startDay + +f.days }))) },
          field('Length in days', h('input', { name: 'days', type: 'number', min: 1, value: length, size: 4 })), h('button', {}, 'Extend / shorten')),
        h('button', { onclick: () => confirm('Cancel this downtime? Nothing is applied and the clock does not move.') && act(() => api('PATCH', `/api/downtime/${w.id}`, { status: 'cancelled' })) }, 'Cancel downtime'),
        h('button', { onclick: () => {
          if (open && !confirm(`${open} activit${open === 1 ? 'y has' : 'ies have'} no decision. Publish anyway and cancel ${open === 1 ? 'it' : 'them'}?`)) return;
          act(() => api('POST', `/api/downtime/${w.id}/publish`, open ? { unresolved: 'cancel' } : {}));
        } }, 'Publish results'))),
    w.status === 'open' && v.bookable.length > 0 && h('section', {}, h('h3', {}, 'Book an activity'),
      h('form', { onsubmit: onSubmit((f, form) => act(async () => {
          await api('POST', `/api/downtime/${w.id}/actions`, { characterId: f.characterId, activity: f.activity, startDay: w.startDay + +f.day - 1, details: f.details, claim: f.claim || null });
          form.reset();
        })) },
        field('Character', h('select', { name: 'characterId' }, v.bookable.map((ch) => h('option', { value: ch.id }, ch.name)))),
        field('Activity', h('select', { name: 'activity' }, w.activities.map((t) => h('option', { value: t.key },
          `${t.name} · ${t.days} d${t.gpCost ? ` · ${t.gpCost} gp` : ''}${t.resolution === 'auto' ? ' · automatic' : t.resolution === 'assisted' ? ` · ${t.skill} check` : ''}`)))),
        field(`Start on day (1–${length})`, h('input', { name: 'day', type: 'number', min: 1, max: length, value: 1, size: 3 })),
        field('Unique resource (optional)', h('input', { name: 'claim', placeholder: 'e.g. the master forge', maxlength: 80 })),
        h('label', { style: 'width:100%' }, 'Plan / details', h('textarea', { name: 'details', rows: 2 })),
        h('button', {}, 'Book'))),
    h('section', {}, h('h3', {}, gm ? 'Approval queue' : 'Your activities'),
      w.actions.length ? h('ul', { style: 'list-style:none;padding:0' }, w.actions.map((a) => actionRow(a, w, gm, act, actName, dayOf)))
        : h('p', { class: 'muted' }, 'Nothing booked yet.')));
}

function actionRow(a, w, gm, act, actName, dayOf) {
  const o = a.outcome;
  const live = ['proposed', 'resolved', 'conflicted'].includes(a.status);
  const decide = (status) => (e) => {
    const f = Object.fromEntries(new FormData(e.target.form));
    act(() => api('PATCH', `/api/downtime-actions/${a.id}`, { status, gmNotes: f.gmNotes,
      ...(status === 'approved' && { outcome: { success: !!f.success, notes: f.notes, rewardGp: +f.rewardGp || 0, rewardXp: +f.rewardXp || 0, rewardItem: f.rewardItem } }) }));
  };
  return h('li', { class: `dt-action ${a.status}`, style: 'margin:10px 0;padding:8px;border:1px solid #8884;border-radius:6px' },
    h('div', {}, h('strong', {}, `${a.characterName}: ${actName(a.activity)}`), ` · day ${dayOf(a.startDay)}, ${a.days} days (${a.startLabel}) · `, h('em', {}, STATUS[a.status])),
    a.claim && h('div', {}, `Wants: ${a.claim}`),
    a.details && h('div', { class: 'muted' }, a.details),
    o && o.roll && h('div', {}, `Roll ${o.roll.formula} = ${o.roll.total} vs DC ${o.roll.dc}: ${o.success ? 'success' : 'failure'}`),
    o && a.status === 'approved' && h('div', {}, [o.notes, o.rewardGp && `+${o.rewardGp} gp`, o.rewardXp && `+${o.rewardXp} XP`, o.rewardItem].filter(Boolean).join(' · ')),
    a.gmNotes && h('div', { class: 'note' }, `GM: ${a.gmNotes}`),
    a.runId && h('button', { class: 'play-run', onclick: () => run(async () => {
      const host = document.getElementById('run-host');
      await runPanel(host, a.runId, () => act(async () => {}));
      host.scrollIntoView({ block: 'start' });
    }) }, gm ? 'Review side quest' : 'Play side quest'),
    !gm && live && h('button', { class: 'link', onclick: () => act(() => api('DELETE', `/api/downtime-actions/${a.id}`)) }, 'withdraw'),
    gm && a.status !== 'cancelled' && h('form', { onsubmit: (e) => e.preventDefault() },
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'success', checked: o ? o.success : true }), 'Success'),
      field('Outcome', h('input', { name: 'notes', value: (o && o.notes) || '' })),
      field('gp', h('input', { name: 'rewardGp', type: 'number', min: 0, value: (o && o.rewardGp) || 0, size: 4 })),
      field('XP', h('input', { name: 'rewardXp', type: 'number', min: 0, value: (o && o.rewardXp) || 0, size: 4 })),
      field('Item', h('input', { name: 'rewardItem', value: (o && o.rewardItem) || '' })),
      field('Note to player', h('input', { name: 'gmNotes', value: a.gmNotes || '' })),
      h('button', { type: 'button', onclick: decide('approved') }, 'Approve'),
      h('button', { type: 'button', onclick: decide('rejected') }, 'Reject'),
      a.status !== 'proposed' && h('button', { type: 'button', onclick: decide('proposed') }, 'Postpone')));
}

function reportOf(w) {
  const r = w.report;
  return h('details', { open: true }, h('summary', {}, `${r.from} to ${r.to} (${r.days} days)${r.cancelled ? ` · ${r.cancelled} cancelled` : ''}`),
    r.characters.map((ch) => h('div', { style: 'margin:6px 0' }, h('strong', {}, ch.name),
      ` · ${ch.gp >= 0 ? '+' : ''}${ch.gp} gp${r.xpApplied ? ` · +${ch.xp} XP` : ''}${ch.items.length ? ` · ${ch.items.join(', ')}` : ''}`,
      h('ul', {}, ch.timeline.map((x) => h('li', {}, `${x.from}: ${x.activity} (${x.days} d) · ${x.status}${x.success === false ? ' · failed' : ''}${x.notes ? ` · ${x.notes}` : ''}${x.effects && x.effects.length ? ` · ${x.effects.join(", ")}` : ''}`))))));
}
