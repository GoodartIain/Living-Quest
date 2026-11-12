// Milestone 5: GM Director Mode — one screen for running a live session: live scene and encounter, party status,
// pending approvals, private notes, story beats and quick creation. Shares the page globals.
/* global h, api, run, state, render, field, options, onSubmit, go, openScene, openCharacter, openWorld, chat, drawChat, voice, drawVoice */
'use strict';

let directorTimer = null;
const campaignOf = () => state.world.campaigns.find((c) => c.id === state.director);

function openDirector(campaignId) {
  state.director = campaignId;
  render();
}
function closeDirector() {
  state.director = null;
  clearInterval(directorTimer);
  render();
}

function renderDirector() {
  const c = campaignOf();
  const d = c.director;
  const save = (body) => run(async () => { Object.assign(c, await api('PATCH', `/api/campaigns/${c.id}/director`, body)); await drawLive(); });
  const beats = h('ul', { style: 'list-style:none;padding:0' });
  const drawBeats = () => beats.replaceChildren(...c.director.beats.map((b) => h('li', {},
    h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: b.done || false,
      onchange: (e) => save({ beats: c.director.beats.map((x) => (x.id === b.id ? { ...x, done: e.target.checked } : x)) }) }),
      h('span', { style: b.done ? 'text-decoration:line-through' : '' }, b.text)), ' ',
    h('button', { class: 'link', onclick: () => save({ beats: c.director.beats.filter((x) => x.id !== b.id) }).then(drawBeats) }, 'remove'))));
  drawBeats();
  $app.append(
    h('section', {}, h('div', { class: 'crumbs' }, h('button', { class: 'link', onclick: closeDirector }, `‹ ${state.world.name}`), '›', h('strong', {}, `Director · ${c.name}`)),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px' },
        h('button', { onclick: () => { chat.open = true; drawChat(true); } }, 'Open chat'),
        h('button', { onclick: () => { voice.open = true; drawVoice(); } }, 'Open voice & video'))),
    h('div', { class: 'row' },
      h('section', { id: 'dir-scene' }, h('p', { class: 'muted' }, 'Loading…')),
      h('section', { id: 'dir-party' }, h('p', { class: 'muted' }, 'Loading…'))),
    h('div', { class: 'row' },
      h('section', {}, h('h3', {}, 'GM notes (only you see these)'),
        h('form', { onsubmit: onSubmit((f) => save({ notes: f.notes })) },
          h('textarea', { name: 'notes', rows: 8, 'aria-label': 'GM notes' }, d.notes), h('button', {}, 'Save notes'))),
      h('section', {}, h('h3', {}, 'Story beats'), beats,
        h('form', { onsubmit: onSubmit(async (f, form) => { await save({ beats: [...c.director.beats, { text: f.text }] }); form.reset(); drawBeats(); }) },
          field('New beat', h('input', { name: 'text', required: true, maxlength: 200 })), h('button', {}, 'Add')),
        h('h3', {}, 'Quick create'),
        h('form', { onsubmit: onSubmit(async (f, form) => {
            const p = await api('POST', `/api/worlds/${state.world.id}/pages`, { title: f.title, kind: f.kind, visibility: f.visibility, body: f.body });
            form.reset();
            document.getElementById('dir-created').replaceChildren(h('button', { class: 'link', onclick: () => run(async () => { state.director = null; await openPage(p.id); }) }, `Open ${p.title}`));
          }) },
          field('Name', h('input', { name: 'title', required: true })),
          field('Kind', h('select', { name: 'kind' }, options(['npc', 'item', 'quest', 'rumour', 'lore'], 'npc'))),
          field('Visible to', h('select', { name: 'visibility' }, options(['gm', 'party', 'public'], 'gm'))),
          h('label', { style: 'width:100%' }, 'Notes', h('textarea', { name: 'body', rows: 2 })),
          h('button', {}, 'Create'), h('span', { id: 'dir-created' })))));
  drawLive();
  clearInterval(directorTimer);
  // shortcut: polls every 5 s while open; switch to the scene/campaign streams if GMs need instant updates
  directorTimer = setInterval(() => { if (state.director && !document.hidden) drawLive(); }, 5000);
}

// Party and live-scene panels only, so notes being typed are never redrawn away.
async function drawLive() {
  const c = campaignOf();
  if (!c || !document.getElementById('dir-scene')) return;
  const [chars, scenes] = await Promise.all([api('GET', `/api/campaigns/${c.id}/characters`), api('GET', `/api/worlds/${state.world.id}/scenes`)]);
  const live = c.director.liveSceneId && await api('GET', `/api/scenes/${c.director.liveSceneId}`).catch(() => null);
  const setLive = (liveSceneId) => run(async () => { Object.assign(c, await api('PATCH', `/api/campaigns/${c.id}/director`, { liveSceneId })); await drawLive(); });
  const enc = live && live.encounter;
  const nameOf = (id) => ((live.tokens.find((t) => t.id === id) || {}).name || '?');
  document.getElementById('dir-scene')?.replaceChildren(h('div', {}, h('h3', {}, 'Live scene'), // h() flattens the nested parts
    scenes.length ? h('form', { onsubmit: onSubmit((f) => setLive(f.scene)) },
      field('Scene', h('select', { name: 'scene' }, scenes.map((s) => h('option', { value: s.id, selected: s.id === c.director.liveSceneId || false }, `${s.name} (${s.location}, ${s.visibility})`)))),
      h('button', {}, 'Make live')) : h('p', { class: 'muted' }, 'Create a scene on a location first.'),
    live ? [h('p', {}, h('strong', {}, `Live: ${live.scene.name}`), ` — players see a "join" banner. `,
        h('button', { class: 'link', onclick: () => run(async () => { state.director = null; await openScene(live.scene.id); }) }, 'open'), ' · ',
        h('button', { class: 'link', onclick: () => setLive(null) }, 'end live')),
      live.scene.visibility === 'gm' && h('p', { class: 'note' }, 'This scene is GM-only, so players cannot see it yet. Share it from the scene settings.'),
      enc ? [h('p', {}, `Encounter · round ${enc.round} · turn: ${enc.turnTokenId ? nameOf(enc.turnTokenId) : '—'}`),
        h('ol', {}, enc.combatants.map((x) => h('li', { class: x.tokenId === enc.turnTokenId ? 'turn' : '' }, `${nameOf(x.tokenId)} — ${x.initiative}`))),
        h('button', { onclick: () => run(async () => { await api('POST', `/api/scenes/${live.scene.id}/encounter/next`); await drawLive(); }) }, 'Next turn')]
        : h('p', { class: 'muted' }, 'No encounter running in this scene.')]
      : h('p', { class: 'muted' }, 'No live scene.')));
  document.getElementById('dir-party')?.replaceChildren(h('div', {}, h('h3', {}, 'Party'),
    chars.length ? h('ul', { style: 'list-style:none;padding:0' }, chars.map((ch) => h('li', { style: 'margin:6px 0' },
      h('button', { class: 'link', onclick: () => run(async () => { state.director = null; await openCharacter(ch.id); }) }, h('strong', {}, ch.name)),
      ` · ${ch.className} ${ch.level} · ${ch.ownerName} · AC ${ch.armorClass}`,
      h('div', {}, h('progress', { max: ch.maxHp, value: ch.hp.current, 'aria-label': `${ch.name} hit points` }),
        ` ${ch.hp.current}/${ch.maxHp}${ch.hp.temp ? ` +${ch.hp.temp}` : ''}`,
        ch.hp.current === 0 && h('strong', {}, ch.deathSaves.dead ? ' · dead' : ch.deathSaves.stable ? ' · stable' : ` · dying (${ch.deathSaves.successes}✓ ${ch.deathSaves.failures}✗)`),
        ch.conditions.length > 0 && ` · ${ch.conditions.join(', ')}`),
      (ch.pendingLevels > 0 || ch.pendingChoices > 0) && h('div', { class: 'note' },
        ch.pendingLevels > 0 && [`${ch.pendingLevels} level-up awaiting approval `,
          h('button', { class: 'link', onclick: () => run(async () => { await api('POST', `/api/characters/${ch.id}/level-up`); await drawLive(); }) }, 'approve'), ' '],
        ch.pendingChoices > 0 && `${ch.pendingChoices} level-up choice(s) for the player to make`))))
      : h('p', { class: 'muted' }, 'No characters in this campaign yet.')));
}

// Players: a banner pointing to the GM's live scene, kept current by the campaign stream.
function liveBanner() {
  const c = state.world.campaigns.find((x) => x.liveSceneId);
  return c && state.world.role !== 'gm' && h('section', { class: 'note', role: 'status' }, h('strong', {}, `${c.name} is live. `),
    h('button', { onclick: () => run(() => openScene(c.liveSceneId)) }, 'Join the scene'));
}
