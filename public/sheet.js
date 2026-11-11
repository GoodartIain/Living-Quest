// Milestone 4 UI: guided character creation, character sheets, advancement controls, dice.
// Shares the page's globals (h, api, run, field, options, check, state, render, onSubmit).
/* global h, api, run, field, options, check, state, render, onSubmit, go, $app */
'use strict';

let RULES = null;
const loadRules = async () => (RULES ||= await api('GET', '/api/ruleset'));
const signed = (n) => (n >= 0 ? `+${n}` : String(n));
const ABIL = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

function formatRoll(r) {
  const parts = r.parts.map((p, i) => {
    const sign = p.sign < 0 ? '− ' : i ? '+ ' : '';
    if (p.flat !== undefined) return sign + p.flat;
    const dice = p.kept ? `${p.dice} (${p.rolls.join(', ')} → ${p.kept.join(', ')})` : `${p.dice} [${p.rolls.join(', ')}]`;
    return sign + dice;
  });
  const mode = r.mode !== 'normal' ? ` (${r.mode})` : '';
  const tag = r.visibility === 'public' ? '' : r.visibility === 'private' ? ' · private' : ' · GM only';
  return `${r.userName}: ${r.label || r.formula}${mode} — ${parts.join(' ')} = ${r.total}${tag}`;
}

async function loadCharacters() {
  const lists = await Promise.all(state.world.campaigns.map((c) => api('GET', `/api/campaigns/${c.id}/characters`)));
  state.chars = lists.flat();
}

// ---- Panel in the world view
function charactersPanel() {
  const w = state.world, gm = w.role === 'gm';
  const canCreate = gm || w.role === 'player';
  return h('section', {}, h('h2', {}, 'Characters'),
    state.chars && state.chars.length
      ? h('ul', {}, state.chars.map((c) => h('li', {},
        h('button', { class: 'link', onclick: () => run(() => openCharacter(c.id)) }, c.name),
        ` — level ${c.level} ${c.species} ${c.className}${c.mine ? ' (yours)' : ` · ${c.ownerName}`}`,
        c.conditions.length ? ` · ${c.conditions.join(', ')}` : '',
        gm && c.pendingLevels ? h('strong', {}, ` · ${c.pendingLevels} level-up pending`) : '')))
      : h('p', { class: 'muted' }, 'No characters yet.'),
    canCreate && h('button', { onclick: () => run(startWizard) }, 'Create a character'),
    gm && w.campaigns.map((c) => advancementForm(c)));
}

function advancementForm(c) {
  const a = c.advancement;
  return h('details', {}, h('summary', {}, `Advancement · ${c.name} (${a.mode === 'xp' ? 'XP' : 'milestone'})`),
    h('form', { onsubmit: onSubmit(async (f) => { await api('PATCH', `/api/campaigns/${c.id}/advancement`, { levelUp: f.levelUp }); await refreshWorld(); }) },
      field('When XP reaches a new level', h('select', { name: 'levelUp' },
        h('option', { value: 'confirm', selected: a.levelUp !== 'auto' || false }, 'GM approves each level'),
        h('option', { value: 'auto', selected: a.levelUp === 'auto' || false }, 'Level up automatically'))),
      h('button', {}, 'Save')),
    a.mode === 'xp'
      ? h('form', { onsubmit: onSubmit(async (f, form) => { await api('POST', `/api/campaigns/${c.id}/xp`, { amount: +f.amount, category: f.category, reason: f.reason }); form.reset(); await refreshWorld(); }) },
        field('Award XP to the whole party', h('input', { name: 'amount', type: 'number', min: 1, required: true, size: 6 })),
        field('For', h('select', { name: 'category' }, options(['combat', 'quest', 'exploration', 'roleplay', 'downtime', 'other'], 'combat'))),
        field('Reason', h('input', { name: 'reason', required: true })),
        h('button', {}, 'Award XP'))
      : h('form', { onsubmit: onSubmit(async (f, form) => { await api('POST', `/api/campaigns/${c.id}/milestone`, { reason: f.reason }); form.reset(); await refreshWorld(); }) },
        field('Milestone reached by the whole party', h('input', { name: 'reason', required: true, placeholder: 'Defeated the bandit queen' })),
        h('button', {}, 'Award a level')));
}

async function refreshWorld() {
  state.world = await api('GET', `/api/worlds/${state.world.id}`);
  await loadCharacters();
  render();
}

// ---- Guided creation
const STEPS = ['Basics', 'Species', 'Class', 'Background', 'Abilities', 'Story', 'Review'];

async function startWizard() {
  await loadRules();
  const mine = state.world.campaigns; // players only receive the campaigns they belong to
  if (!mine.length) throw new Error('Create a campaign first.');
  state.wizard = { step: 0, d: { campaignId: mine[0].id, name: '', portraitUrl: '', species: 'Human', speciesSkills: [], className: 'Fighter', classSkills: [],
    background: 'Soldier', bonusMode: '21', plus2: 'str', plus1: 'con', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, personality: '', backstory: '' } };
  state.character = null;
  render();
}

function bonusOf(d) {
  const bg = RULES.backgrounds[d.background];
  return d.bonusMode === '111' ? Object.fromEntries(bg.abilities.map((a) => [a, 1])) : { [d.plus2]: 2, [d.plus1]: 1 };
}
function stepProblem(i, d) {
  const sp = RULES.species[d.species], cls = RULES.classes[d.className], bg = RULES.backgrounds[d.background];
  if (i === 0 && !d.name.trim()) return 'Give your character a name.';
  if (i === 1 && sp.skills && d.speciesSkills.length !== sp.skills.count) return `Choose ${sp.skills.count} skill from your species.`;
  if (i === 2 && d.classSkills.length !== cls.skills.count) return `Choose ${cls.skills.count} skills.`;
  if (i === 3 && (d.classSkills.length !== cls.skills.count || (sp.skills && d.speciesSkills.length !== sp.skills.count))) return 'Your new background already grants some of your chosen skills: go back and pick replacements.';
  if (i === 3 && d.bonusMode === '21' && (d.plus2 === d.plus1 || !bg.abilities.includes(d.plus2) || !bg.abilities.includes(d.plus1))) return 'Pick two different abilities from your background.';
  if (i === 4) {
    const v = RULES.abilities.map((a) => d.baseScores[a]);
    if (d.abilityMethod === 'standard' && [...v].sort((a, b) => b - a).join() !== RULES.standardArray.join()) return `Use each of ${RULES.standardArray.join(', ')} once.`;
    if (d.abilityMethod === 'pointbuy') {
      const spent = v.reduce((n, x) => n + (RULES.pointCost[x] ?? 99), 0);
      if (spent > RULES.points) return `You spent ${spent} of ${RULES.points} points.`;
    }
  }
  return null;
}

function renderWizard() {
  const wz = state.wizard, d = wz.d, i = wz.step;
  const redraw = () => render();
  const set = (k) => (e) => { d[k] = e.target.value; };
  const choose = (list, chosen, max, key) => h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 12px' }, list.map((s) =>
    h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: chosen.includes(s) || false, disabled: !chosen.includes(s) && chosen.length >= max || false,
      onchange: (e) => { d[key] = e.target.checked ? [...chosen, s] : chosen.filter((x) => x !== s); redraw(); } }), s)));
  const taken = () => new Set([...RULES.backgrounds[d.background].skills]);
  const sp = RULES.species[d.species], cls = RULES.classes[d.className], bg = RULES.backgrounds[d.background];
  const body = [
    () => [field('Campaign', h('select', { onchange: set('campaignId') }, state.world.campaigns.map((c) => h('option', { value: c.id, selected: c.id === d.campaignId || false }, c.name)))),
      field('Name', h('input', { value: d.name, oninput: set('name'), required: true })),
      field('Portrait image URL (optional)', h('input', { type: 'url', value: d.portraitUrl, oninput: set('portraitUrl') }))],
    () => [field('Species', h('select', { onchange: (e) => { d.species = e.target.value; d.speciesSkills = []; redraw(); } }, options(Object.keys(RULES.species), d.species))),
      h('p', { class: 'muted' }, `${sp.size} · speed ${sp.speed} ft · ${sp.traits.join(', ')}`),
      sp.skills && [h('p', {}, `Choose ${sp.skills.count} skill proficiency:`), choose(sp.skills.from.filter((s) => !taken().has(s) && !d.classSkills.includes(s)), d.speciesSkills, sp.skills.count, 'speciesSkills')]],
    () => [field('Class', h('select', { onchange: (e) => { d.className = e.target.value; d.classSkills = []; redraw(); } }, options(Object.keys(RULES.classes), d.className))),
      h('p', { class: 'muted' }, `Hit die d${cls.hitDie} · saving throws ${cls.saves.map((a) => ABIL[a]).join(', ')}`),
      h('p', {}, `Choose ${cls.skills.count} skills (${[...taken()].join(', ')} come from your background):`),
      choose(cls.skills.from.filter((s) => !taken().has(s) && !d.speciesSkills.includes(s)), d.classSkills, cls.skills.count, 'classSkills')],
    () => [field('Background', h('select', { onchange: (e) => { d.background = e.target.value; const nb = RULES.backgrounds[d.background];
        if (!nb.abilities.includes(d.plus2) || !nb.abilities.includes(d.plus1)) [d.plus2, d.plus1] = nb.abilities;
        // keep earlier skill picks unless the new background already grants them
        d.classSkills = d.classSkills.filter((x) => !nb.skills.includes(x)); d.speciesSkills = d.speciesSkills.filter((x) => !nb.skills.includes(x)); redraw(); } }, options(Object.keys(RULES.backgrounds), d.background))),
      h('p', { class: 'muted' }, `Skills ${bg.skills.join(', ')} · feat ${bg.feat} · ${bg.tool}`),
      field('Ability increase', h('select', { onchange: (e) => { d.bonusMode = e.target.value; redraw(); } },
        h('option', { value: '21', selected: d.bonusMode === '21' || false }, '+2 to one, +1 to another'),
        h('option', { value: '111', selected: d.bonusMode === '111' || false }, `+1 to each of ${bg.abilities.map((a) => ABIL[a]).join(', ')}`))),
      d.bonusMode === '21' && [field('+2', h('select', { onchange: (e) => { d.plus2 = e.target.value; redraw(); } }, bg.abilities.map((a) => h('option', { value: a, selected: a === d.plus2 || false }, ABIL[a])))),
        field('+1', h('select', { onchange: (e) => { d.plus1 = e.target.value; redraw(); } }, bg.abilities.map((a) => h('option', { value: a, selected: a === d.plus1 || false }, ABIL[a]))))]],
    () => {
      const bonus = bonusOf(d);
      const spent = RULES.abilities.reduce((n, a) => n + (RULES.pointCost[d.baseScores[a]] ?? 0), 0);
      return [field('Method', h('select', { onchange: (e) => { d.abilityMethod = e.target.value;
          d.baseScores = e.target.value === 'standard' ? { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 } : { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 }; redraw(); } },
          h('option', { value: 'standard', selected: d.abilityMethod === 'standard' || false }, 'Standard array (15, 14, 13, 12, 10, 8)'),
          h('option', { value: 'pointbuy', selected: d.abilityMethod === 'pointbuy' || false }, `Point buy (${RULES.points} points)`))),
        d.abilityMethod === 'pointbuy' && h('p', {}, `Points left: ${RULES.points - spent}`),
        h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;width:100%' }, RULES.abilities.map((a) =>
          field(`${ABIL[a]}${bonus[a] ? ` (+${bonus[a]} → ${d.baseScores[a] + bonus[a]})` : ''}`, d.abilityMethod === 'standard'
            ? h('select', { onchange: (e) => { d.baseScores[a] = +e.target.value; redraw(); } }, RULES.standardArray.map((v) => h('option', { value: v, selected: v === d.baseScores[a] || false }, v)))
            : h('input', { type: 'number', min: 8, max: 15, value: d.baseScores[a], onchange: (e) => { d.baseScores[a] = +e.target.value; redraw(); } }))))];
    },
    () => [h('label', { style: 'width:100%' }, 'Personality', h('textarea', { oninput: set('personality') }, d.personality)),
      h('label', { style: 'width:100%' }, 'Backstory', h('textarea', { oninput: set('backstory') }, d.backstory))],
    () => {
      const bonus = bonusOf(d);
      return [h('ul', {},
        h('li', {}, `${d.name} — ${d.species} ${d.className}, ${d.background}`),
        h('li', {}, RULES.abilities.map((a) => `${a.toUpperCase()} ${d.baseScores[a] + (bonus[a] || 0)}`).join(' · ')),
        h('li', {}, `Skills: ${[...bg.skills, ...d.classSkills, ...d.speciesSkills].join(', ')}`),
        h('li', {}, `Feat: ${bg.feat} · ${bg.tool}`))];
    },
  ][i]();

  const problem = stepProblem(i, d);
  $app.append(h('section', {},
    h('button', { class: 'link', onclick: () => { state.wizard = null; render(); } }, '‹ cancel'),
    h('h2', {}, `New character · ${STEPS[i]} (${i + 1}/${STEPS.length})`),
    h('form', { onsubmit: (e) => e.preventDefault() }, body),
    problem && i < STEPS.length - 1 && h('p', { class: 'muted' }, problem),
    h('div', { style: 'display:flex;gap:8px' },
      i > 0 && h('button', { onclick: () => { wz.step--; render(); } }, 'Back'),
      i < STEPS.length - 1
        ? h('button', { onclick: () => { const p = stepProblem(i, d); if (p) { document.getElementById('err').textContent = p; return; } wz.step++; render(); } }, 'Next')
        : h('button', { onclick: () => run(async () => {
          for (let s = 0; s < STEPS.length - 1; s++) { const p = stepProblem(s, d); if (p) { wz.step = s; render(); throw new Error(p); } }
          const r = await api('POST', `/api/campaigns/${d.campaignId}/characters`, { name: d.name, portraitUrl: d.portraitUrl || undefined,
            species: d.species, className: d.className, background: d.background, abilityMethod: d.abilityMethod, baseScores: d.baseScores,
            backgroundBonus: bonusOf(d), classSkills: d.classSkills, speciesSkills: d.speciesSkills, personality: d.personality, backstory: d.backstory });
          state.wizard = null;
          await loadCharacters();
          await openCharacter(r.character.id);
        }) }, 'Create character'))));
}

// ---- Sheet
async function openCharacter(id) {
  await loadRules();
  state.character = await api('GET', `/api/characters/${id}`);
  state.wizard = null;
  render();
}
async function reloadCharacter(v) {
  state.character = v && v.character ? { access: 'full', ...v } : await api('GET', `/api/characters/${state.character.character ? state.character.character.id : state.character.id}`);
  await loadCharacters();
  render();
}

function rollControls() {
  return h('form', { id: 'rollopts', style: 'margin:4px 0', onsubmit: (e) => e.preventDefault() },
    field('Roll with', h('select', { name: 'mode' }, options(['normal', 'advantage', 'disadvantage'], 'normal'))),
    field('Show to', h('select', { name: 'visibility' }, h('option', { value: 'public' }, 'everyone'), h('option', { value: 'private' }, 'me and the GM'),
      state.world.role === 'gm' && h('option', { value: 'gm' }, 'GM only'))),
    h('span', { id: 'lastroll', 'aria-live': 'polite' }, state.lastRoll ? formatRoll(state.lastRoll) : ''));
}
async function rollCheck(c, chk) {
  const o = Object.fromEntries(new FormData(document.getElementById('rollopts')));
  state.lastRoll = await api('POST', `/api/worlds/${state.world.id}/rolls`, { characterId: c.id, check: chk, mode: o.mode, visibility: o.visibility });
  document.getElementById('lastroll').textContent = formatRoll(state.lastRoll);
}

function renderSheet() {
  const v = state.character, gm = state.world.role === 'gm';
  const back = h('button', { class: 'link', onclick: () => run(() => go(state.loc.location.id)) }, `‹ ${state.loc.location.name}`); // reload: the world may have changed meanwhile
  if (v.access !== 'full') {
    return $app.append(h('section', {}, back, h('h2', {}, v.name),
      v.portraitUrl && h('img', { src: v.portraitUrl, alt: `Portrait of ${v.name}`, style: 'max-width:160px;border-radius:8px' }),
      h('p', {}, `Level ${v.level} ${v.species} ${v.className} · played by ${v.ownerName}`),
      v.conditions.length > 0 && h('p', {}, `Conditions: ${v.conditions.join(', ')}`)));
  }
  const c = v.character, s = v.sheet, adv = v.advancement;
  const roll = (chk, label) => h('button', { class: 'link', onclick: () => run(() => rollCheck(c, chk)), 'aria-label': `Roll ${label}` }, label);
  const hpForm = h('form', { onsubmit: (e) => e.preventDefault() },
    field('Amount', h('input', { name: 'n', type: 'number', min: 0, max: 10000, value: 1, size: 4 })),
    ['damage', 'heal', 'temp'].map((k) => h('button', { onclick: (e) => run(async () => {
      const n = +new FormData(e.target.form).get('n');
      await reloadCharacter(await api('POST', `/api/characters/${c.id}/hp`, { [k]: n }));
    }) }, k === 'temp' ? 'Set temp HP' : k[0].toUpperCase() + k.slice(1))));

  const progress = adv.mode === 'xp'
    ? [h('p', {}, `XP ${v.xp}${v.nextLevelXp ? ` / ${v.nextLevelXp} for level ${v.level + 1}` : ' (max level)'}`),
      v.nextLevelXp && h('progress', { max: v.nextLevelXp, value: Math.min(v.xp, v.nextLevelXp), 'aria-label': 'XP towards next level' }),
      v.pendingLevels > 0 && h('p', {}, h('strong', {}, `${v.pendingLevels} level-up waiting for GM approval`),
        gm && [' ', h('button', { onclick: () => run(async () => reloadCharacter(await api('POST', `/api/characters/${c.id}/level-up`))) }, 'Approve next level')])]
    : [h('p', { class: 'muted' }, 'Milestone advancement: the GM awards levels at story milestones.')];

  $app.append(h('section', {}, back,
    h('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap' },
      c.portraitUrl && h('img', { src: c.portraitUrl, alt: `Portrait of ${c.name}`, style: 'width:96px;height:96px;object-fit:cover;border-radius:8px' }),
      h('div', {}, h('h2', {}, c.name), h('p', { class: 'muted', style: 'margin:0' }, `Level ${v.level} ${c.species} ${c.className} · ${c.background} · ${s.size}`))),
    progress));

  $app.append(h('div', { class: 'row' },
    h('section', {},
      h('h3', {}, `Hit points ${c.hp.current} / ${s.maxHp}${c.hp.temp ? ` (+${c.hp.temp} temp)` : ''}`),
      h('progress', { max: s.maxHp, value: c.hp.current, 'aria-label': 'Hit points' }), hpForm,
      h('p', {}, `AC ${s.armorClass} (unarmored) · Speed ${s.speed} ft · Proficiency ${signed(s.proficiencyBonus)} · Passive Perception ${s.passivePerception} · Hit die ${s.hitDie} · `,
        roll('initiative', `Initiative ${signed(s.initiative)}`)),
      rollControls(),
      h('table', { style: 'width:100%;border-collapse:collapse' },
        h('tr', {}, h('th', { align: 'left' }, 'Ability'), h('th', {}, 'Score'), h('th', {}, 'Check'), h('th', {}, 'Save')),
        Object.keys(s.modifiers).map((a) => h('tr', {},
          h('td', {}, ABIL[a]), h('td', { align: 'center' }, c.abilities[a]),
          h('td', { align: 'center' }, roll(`ability:${a}`, signed(s.modifiers[a]))),
          h('td', { align: 'center' }, roll(`save:${a}`, signed(s.saves[a]) + (s.savingThrowProficiencies.includes(a) ? ' •' : '')))))),
      h('h3', {}, 'Skills'),
      h('ul', { style: 'columns:2' }, Object.entries(s.skills).map(([k, n]) => h('li', {}, roll(`skill:${k}`, `${k} ${signed(n)}`), c.skills.includes(k) ? ' •' : ''))),
      h('p', { class: 'muted' }, `• proficient · Feats: ${c.feats.join(', ')} · Tools: ${c.tools.join(', ')} · Traits: ${s.traits.join(', ')}`)),
    h('section', {},
      h('h3', {}, 'Conditions'),
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 12px' }, (RULES ? RULES.conditions : c.conditions).map((x) => h('label', { class: 'inline' },
        h('input', { type: 'checkbox', checked: c.conditions.includes(x) || false, onchange: (e) => run(async () =>
          reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { conditions: e.target.checked ? [...c.conditions, x] : c.conditions.filter((y) => y !== x) }))) }), x))),
      inventoryEditor(c),
      h('h3', {}, 'Story'),
      h('form', { onsubmit: onSubmit(async (f) => reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { name: f.name, personality: f.personality, backstory: f.backstory }))) },
        field('Name', h('input', { name: 'name', value: c.name })),
        h('label', { style: 'width:100%' }, 'Personality', h('textarea', { name: 'personality' }, c.personality)),
        h('label', { style: 'width:100%' }, 'Backstory', h('textarea', { name: 'backstory' }, c.backstory)),
        h('button', {}, 'Save story')),
      h('h3', {}, 'Level history'),
      v.history.length ? h('ol', {}, v.history.map((e) => h('li', {}, `${new Date(e.at).toLocaleDateString()} · `,
        e.kind === 'xp' ? `+${e.amount} XP (${e.category}) — ${e.reason}` : `Level up${e.auto ? ' (automatic)' : ''} — ${e.reason}`, ` · ${e.by}`)))
        : h('p', { class: 'muted' }, 'Nothing yet.'),
      gm && adv.mode === 'xp' && h('form', { onsubmit: onSubmit(async (f) => { await api('POST', `/api/campaigns/${c.campaignId}/xp`, { amount: +f.amount, category: f.category, reason: f.reason, characterIds: [c.id] }); await reloadCharacter(); }) },
        field(`Award XP to ${c.name}`, h('input', { name: 'amount', type: 'number', min: 1, required: true, size: 6 })),
        field('For', h('select', { name: 'category' }, options(['combat', 'quest', 'exploration', 'roleplay', 'downtime', 'other'], 'roleplay'))),
        field('Reason', h('input', { name: 'reason', required: true })), h('button', {}, 'Award')),
      gm && adv.mode === 'milestone' && h('form', { onsubmit: onSubmit(async (f) => { await api('POST', `/api/campaigns/${c.campaignId}/milestone`, { reason: f.reason, characterIds: [c.id] }); await reloadCharacter(); }) },
        field(`Award ${c.name} a level`, h('input', { name: 'reason', required: true, placeholder: 'Personal quest complete' })), h('button', {}, 'Award level')))));
}

function inventoryEditor(c) {
  const rows = c.inventory.map((it) => ({ ...it }));
  const list = h('div', {});
  const draw = () => list.replaceChildren(...rows.map((it, i) => h('div', { style: 'display:flex;gap:6px;margin:4px 0;flex-wrap:wrap' },
    h('input', { value: it.name, 'aria-label': 'Item', oninput: (e) => { it.name = e.target.value; } }),
    h('input', { type: 'number', min: 0, value: it.qty, size: 3, 'aria-label': 'Quantity', oninput: (e) => { it.qty = +e.target.value; } }),
    h('input', { value: it.notes, placeholder: 'notes', 'aria-label': 'Notes', oninput: (e) => { it.notes = e.target.value; } }),
    h('button', { class: 'link', type: 'button', onclick: () => { rows.splice(i, 1); draw(); } }, 'remove'))));
  draw();
  return [h('h3', {}, 'Inventory'), list,
    h('form', { onsubmit: onSubmit(async (f) => reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, {
        inventory: rows.filter((r) => r.name.trim()), currency: Object.fromEntries(['cp', 'sp', 'ep', 'gp', 'pp'].map((k) => [k, +f[k] || 0])) }))) },
      h('button', { type: 'button', class: 'link', onclick: () => { rows.push({ name: '', qty: 1, notes: '' }); draw(); } }, '+ add item'),
      h('div', { style: 'display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;width:100%' }, ['cp', 'sp', 'ep', 'gp', 'pp'].map((k) => field(k.toUpperCase(), h('input', { name: k, type: 'number', min: 0, value: c.currency[k], style: 'width:100%' })))),
      h('button', {}, 'Save inventory'))];
}
