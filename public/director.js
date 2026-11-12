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
    h('section', { id: 'dir-stream' }),
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
  run(() => drawStream());
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

// Livestream (Milestones 7 and 12): the broadcast link for OBS, the scene playlist and takes, the stream camera, title
// cards and overlays, audience poll, delay and highlights — all private GM controls — plus a preview of exactly what airs.
async function drawStream(link) {
  const c = campaignOf();
  const box = document.getElementById('dir-stream');
  if (!c || !box) return;
  const [b, scenes, prev] = await Promise.all([api('GET', `/api/campaigns/${c.id}/broadcast`), api('GET', `/api/worlds/${state.world.id}/scenes`),
    api('GET', `/api/campaigns/${c.id}/broadcast/preview`)]);
  const patch = (body) => run(async () => { const r = await api('PATCH', `/api/campaigns/${c.id}/broadcast`, body); await drawStream(r.key && `${location.origin}/broadcast.html#key=${r.key}`); });
  const redraw = (fn) => run(async () => { await fn(); await drawStream(); });
  const sceneName = (id) => (scenes.find((x) => x.id === id) || {}).name || '?';
  const onAir = scenes.find((x) => x.id === b.sceneId);
  const tokens = prev.scene ? prev.scene.tokens : [];
  const poll = b.poll;
  const counts = poll && poll.options.map((_, i) => Object.values(poll.votes).filter((v) => v === i).length);
  box.replaceChildren(h('div', { class: 'stream-panel' }, h('h3', {}, `Livestream · ${b.enabled ? 'ON AIR' : 'off'}${b.enabled ? ` · ${b.viewers} watching` : ''}${b.delaySeconds ? ` · ${b.delaySeconds} s delay` : ''}`),
    h('p', { class: 'muted' }, 'The stream shows exactly what a spectator may see of the on-air scene. Everything in this panel is yours alone.'),
    link && h('div', { class: 'note' }, h('p', {}, h('strong', {}, 'Broadcast link for OBS (shown once; keep it private): ')),
      h('input', { value: link, readonly: true, style: 'width:100%', 'aria-label': 'Broadcast link', onfocus: (e) => e.target.select() }),
      h('p', { class: 'muted' }, 'Add it as a Browser Source (1920×1080). The camera and overlays follow your choices here.')),
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
      h('button', { onclick: () => patch({ enabled: !b.enabled }) }, b.enabled ? 'Stop streaming now' : 'Go on air'),
      b.hasKey && h('button', { onclick: () => confirm('Make a new link? The current link stops working at once.') && patch({ rotateKey: true, enabled: true }) }, 'Make a new link'),
      b.enabled && h('button', { onclick: () => redraw(() => api('POST', `/api/campaigns/${c.id}/highlights`, { note: prompt('Highlight note (optional)') || '' })) }, 'Mark highlight')),
    h('h4', {}, 'Scenes in the show'),
    h('div', { class: 'playlist', style: 'display:flex;gap:6px;flex-wrap:wrap' }, b.playlist.map((id) => h('button', { 'aria-pressed': String(id === b.sceneId),
      onclick: () => patch({ sceneId: id, card: null }) }, `${id === b.sceneId ? '● ' : ''}Take ${sceneName(id)}`))),
    h('details', {}, h('summary', {}, 'Choose scenes'), h('form', { onsubmit: (e) => { e.preventDefault(); patch({ playlist: [...e.target.querySelectorAll('input:checked')].map((i) => i.value) }); } },
      scenes.map((x) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', value: x.id, checked: b.playlist.includes(x.id) }), `${x.name} (${x.visibility})`)), h('button', {}, 'Save playlist'))),
    onAir && onAir.visibility !== 'public' && h('p', { class: 'note' }, `"${onAir.name}" is not public, so the stream shows "not shown on stream".`),
    h('h4', {}, 'Camera and cards'),
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:end' },
      field('Camera', h('select', { name: 'camera', onchange: (e) => patch({ camera: e.target.value }) }, options(['board', 'tactical', 'cinematic', 'follow'], b.camera))),
      b.camera === 'follow' && field('Follow', h('select', { onchange: (e) => patch({ followTokenId: e.target.value || null }) }, h('option', { value: '' }, '—'),
        tokens.map((t) => h('option', { value: t.id, selected: t.id === b.followTokenId || false }, t.name)))),
      ['starting', 'break', 'ending'].map((k) => h('button', { 'aria-pressed': String(!!b.card && b.card.kind === k), onclick: () => patch({ card: b.card && b.card.kind === k ? null : { kind: k } }) },
        { starting: 'Starting soon', break: 'Be right back', ending: 'Ending' }[k])),
      b.card && h('button', { onclick: () => patch({ card: null }) }, 'Back to the scene')),
    h('form', { onsubmit: onSubmit((f) => patch({ title: f.title, lowerThird: f.lowerThird, branding: { text: f.brandText, imageUrl: f.brandImage }, accent: f.accent,
        showParty: f.showParty, delaySeconds: +f.delay || 0, showInitiative: !!f.showInitiative, showRolls: !!f.showRolls, reactions: !!f.reactions })) },
      field('Title', h('input', { name: 'title', value: b.title, maxlength: 120 })),
      field('Caption (lower third)', h('input', { name: 'lowerThird', value: b.lowerThird, maxlength: 160, size: 30 })),
      field('Sponsor / branding text', h('input', { name: 'brandText', value: b.branding.text, maxlength: 80 })),
      field('Branding image URL', h('input', { name: 'brandImage', value: b.branding.imageUrl, type: 'url' })),
      field('Accent', h('input', { name: 'accent', type: 'color', value: b.accent })),
      field('Party panel', h('select', { name: 'showParty' }, options(['off', 'names', 'health'], b.showParty))),
      field('Delay (s)', h('input', { name: 'delay', type: 'number', min: 0, max: 120, value: b.delaySeconds, size: 3 })),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'showInitiative', checked: b.showInitiative }), 'Initiative'),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'showRolls', checked: b.showRolls }), 'Public rolls'),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'reactions', checked: b.reactions }), 'Audience reactions'),
      h('button', {}, 'Save overlays')),
    h('p', { class: 'muted' }, 'The party panel shows only characters whose players agreed on their sheet.'),
    h('h4', {}, 'Audience poll'),
    poll ? h('div', {}, h('p', {}, h('strong', {}, poll.question), poll.open ? ' (open)' : ' (closed)'),
      h('ul', {}, poll.options.map((o, i) => h('li', {}, `${o}: ${counts[i]}`))),
      poll.open && h('button', { onclick: () => redraw(() => api('PATCH', `/api/campaigns/${c.id}/poll`, { open: false })) }, 'Close poll'), ' ',
      h('button', { onclick: () => redraw(() => api('PATCH', `/api/campaigns/${c.id}/poll`, { clear: true })) }, 'Remove from stream'),
      h('p', { class: 'muted' }, 'Polls never change the game by themselves; you decide what to do with the result.'))
      : h('form', { onsubmit: onSubmit((f) => redraw(() => api('POST', `/api/campaigns/${c.id}/poll`, { question: f.q, options: f.opts.split('\n').map((x) => x.trim()).filter(Boolean) }))) },
        field('Question', h('input', { name: 'q', required: true, maxlength: 160 })),
        h('label', {}, 'Options (one per line)', h('textarea', { name: 'opts', rows: 3, required: true })), h('button', {}, 'Start poll')),
    b.highlights.length > 0 && h('details', {}, h('summary', {}, `Highlights (${b.highlights.length})`),
      h('ul', {}, b.highlights.slice().reverse().map((x) => h('li', {}, `${new Date(x.at).toLocaleTimeString()} · day ${x.day + 1}${x.note ? ` · ${x.note}` : ''}`)))),
    h('h4', {}, 'On the stream right now'),
    h('p', { class: 'stream-preview' }, prev.card ? `Title card: "${prev.card.text}"` : prev.scene ? `${prev.scene.scene.name} (${prev.camera} camera): ${prev.scene.tokens.map((t) => t.name).join(', ') || 'no tokens'}`
      : prev.notPublic ? 'Not shown on stream (scene not public).' : 'Stand by.',
      prev.lowerThird ? ` · caption "${prev.lowerThird}"` : '', prev.party.length ? ` · party: ${prev.party.map((x) => x.name).join(', ')}` : '')));
}

// Players: a banner pointing to the GM's live scene, kept current by the campaign stream.
function liveBanner() {
  const c = state.world.campaigns.find((x) => x.liveSceneId);
  return c && state.world.role !== 'gm' && h('section', { class: 'note', role: 'status' }, h('strong', {}, `${c.name} is live. `),
    h('button', { onclick: () => run(() => openScene(c.liveSceneId)) }, 'Join the scene'));
}
