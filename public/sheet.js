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
    h('form', { onsubmit: onSubmit(async (f) => { await api('PATCH', `/api/campaigns/${c.id}/advancement`, { levelUp: f.levelUp, alignLevels: !!f.alignLevels }); await refreshWorld(); }) },
      field('When XP reaches a new level', h('select', { name: 'levelUp' },
        h('option', { value: 'confirm', selected: a.levelUp !== 'auto' || false }, 'GM approves each level'),
        h('option', { value: 'auto', selected: a.levelUp === 'auto' || false }, 'Level up automatically'))),
      check('Keep party levels aligned (whole-party awards; new characters join at the party level)', 'alignLevels', a.alignLevels),
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
const STEPS = ['Basics', 'Species', 'Class', 'Background', 'Equipment', 'Abilities', 'Story', 'Review'];

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
  if (i === 5) {
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
      sp.size === 'Medium or Small' && field('Size', h('select', { onchange: set('size') }, options(['Medium', 'Small'], d.size || 'Medium'))),
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
      const pick = (label, key, set) => set && [h('p', {}, h('strong', {}, label)),
        set.options.map((o, n) => h('label', { class: 'inline', style: 'width:100%;align-items:flex-start' },
          h('input', { type: 'radio', name: key, checked: d[key] === n || false, onchange: () => { d[key] = n; } }),
          `${String.fromCharCode(65 + n)}: ${[...o.items.map((it) => `${it.count > 1 ? `${it.count} ` : ''}${it.name}`), o.gp ? `${o.gp} GP` : ''].filter(Boolean).join(', ')}`))];
      return [pick(`${d.className} equipment`, 'classEquipment', RULES.startingEquipment[d.className]),
        pick(`${d.background} equipment`, 'backgroundEquipment', RULES.startingEquipment[d.background]),
        h('p', { class: 'muted' }, 'Weapons and armour you are trained with are equipped; everything goes into the inventory.')];
    },
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
            backgroundBonus: bonusOf(d), classSkills: d.classSkills, speciesSkills: d.speciesSkills, size: RULES.species[d.species].size === 'Medium or Small' ? d.size || 'Medium' : undefined, classEquipment: d.classEquipment ?? 0, backgroundEquipment: d.backgroundEquipment ?? 0, personality: d.personality, backstory: d.backstory });
          state.wizard = null;
          await loadCharacters();
          await openCharacter(r.character.id);
        }) }, 'Create character'))));
}

// ---- Sheet
async function openCharacter(id) {
  await loadRules();
  if (!state.character || (state.character.character || state.character).id !== id) { state.lastRolls = []; state.lastNote = null; }
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
    check('Critical hit (double damage dice)', 'crit'),
    h('span', { id: 'lastroll', 'aria-live': 'polite', style: 'width:100%' }, [state.lastNote, ...(state.lastRolls || []).map(formatRoll)].filter(Boolean).join(' · ')));
}
const rollOpts = () => Object.fromEntries(new FormData(document.getElementById('rollopts')));
function showRolls(rolls) {
  state.lastRolls = rolls;
  state.lastNote = null;
  const el = document.getElementById('lastroll');
  if (el) el.textContent = rolls.map(formatRoll).join(' · ');
}
async function rollCheck(c, chk, extra = {}) {
  const o = rollOpts();
  const damage = chk.startsWith('damage:') || chk === 'sneak';
  showRolls([await api('POST', `/api/worlds/${state.world.id}/rolls`, { characterId: c.id, check: chk, mode: damage ? 'normal' : o.mode, visibility: o.visibility, crit: damage && !!o.crit, ...extra })]);
}

function attacksSection(c, s) {
  const roll = (chk, label, extra) => h('button', { class: 'link', onclick: () => run(() => rollCheck(c, chk, extra)) }, label);
  const save = (weapons) => run(async () => reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { weapons })));
  return h('section', {}, h('h3', {}, 'Attacks'),
    h('table', { style: 'width:100%;border-collapse:collapse' },
      h('tr', {}, h('th', { align: 'left' }, 'Weapon'), h('th', {}, 'To hit'), h('th', {}, 'Damage'), h('th', { align: 'left' }, 'Properties'), h('th', {})),
      s.attacks.map((a) => h('tr', {},
        h('td', {}, a.name, a.proficient ? '' : h('span', { class: 'muted' }, ' (not proficient)')),
        h('td', { align: 'center' }, roll(`attack:${a.id}`, signed(a.toHit))),
        h('td', { align: 'center' }, roll(`damage:${a.id}`, `${a.damage} ${a.type}`),
          a.versatileDamage && [' · ', roll(`damage:${a.id}`, `${a.versatileDamage} two-handed`, { versatile: true })]),
        h('td', { class: 'muted' }, a.properties.join(', '), a.mastery && [a.properties.length ? ' · ' : '', h('abbr', { title: a.mastery.description }, `Mastery: ${a.mastery.name}`)]),
        h('td', {}, a.id !== 'unarmed' && h('button', { class: 'link', onclick: () => save(c.weapons.filter((w) => w.id !== a.id)) }, 'remove'))))),
    h('form', { onsubmit: onSubmit((f) => save([...c.weapons, { weapon: f.weapon, bonus: +f.bonus }])) },
      field('Add a weapon', h('select', { name: 'weapon' }, Object.entries(RULES.weapons).map(([n, w]) => h('option', { value: n }, `${n} (${w.category}, ${w.damage} ${w.type})`)))),
      field('Magic', h('select', { name: 'bonus' }, [0, 1, 2, 3].map((n) => h('option', { value: n }, n ? `+${n}` : 'none')))),
      h('button', {}, 'Add')),
    h('details', {}, h('summary', {}, 'Add a custom weapon'),
      h('form', { onsubmit: onSubmit((f) => save([...c.weapons, { bonus: +f.bonus, custom: { name: f.name, damage: f.damage, type: f.type, category: f.category,
          properties: f.properties.split(',').map((x) => x.trim()).filter(Boolean) } }])) },
        field('Name', h('input', { name: 'name', required: true })),
        field('Damage', h('input', { name: 'damage', required: true, placeholder: '1d8', size: 5 })),
        field('Type', h('select', { name: 'type' }, options(['slashing', 'piercing', 'bludgeoning', 'acid', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'poison', 'psychic', 'radiant', 'thunder'], 'slashing'))),
        field('Category', h('select', { name: 'category' }, options(['simple melee', 'simple ranged', 'martial melee', 'martial ranged'], 'martial melee'))),
        field('Magic', h('select', { name: 'bonus' }, [0, 1, 2, 3].map((n) => h('option', { value: n }, n ? `+${n}` : 'none')))),
        h('label', { style: 'width:100%' }, 'Properties (comma-separated: Finesse, Light, Heavy, Reach, Two-Handed, Loading, Versatile (1d10), Thrown (20/60), Ammunition (80/320))', h('input', { name: 'properties' })),
        h('button', {}, 'Add custom weapon'))),
    s.sneakAttack && h('p', {}, h('button', { class: 'link', onclick: () => run(() => rollCheck(c, 'sneak')) }, `Sneak Attack ${s.sneakAttack}`), h('span', { class: 'muted' }, ' — once per turn, with a Finesse or ranged weapon and Advantage or an ally nearby')),
    s.rage && h('p', {}, h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: s.rage.active || false,
      onchange: (e) => run(async () => reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { raging: e.target.checked }))) }),
      `Raging (+${s.rage.damage} damage on Strength attacks; ${s.rage.uses} rages per long rest)`)),
    s.martialArtsDie && h('p', { class: 'muted' }, `Martial Arts die ${s.martialArtsDie} (unarmed, no armour or shield).`),
    armorEditor(c, s), masteryEditor(c, s));
}

function armorEditor(c, s) {
  return [h('h3', {}, `Armour · AC ${s.armorClass}`),
    h('form', { onsubmit: onSubmit(async (f) => reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { armor: f.armor || null, shield: !!f.shield }))) },
      field('Armour', h('select', { name: 'armor' }, h('option', { value: '' }, 'none'),
        Object.entries(RULES.armor).filter(([n]) => n !== 'Shield').map(([n, a]) => h('option', { value: n, selected: c.armor === n || false },
          `${n} (${a.category}, AC ${a.base}${a.dexMax === null ? ' + DEX' : a.dexMax ? ` + DEX max ${a.dexMax}` : ''})`)))),
      check('Shield (+2)', 'shield', c.shield), h('button', {}, 'Save armour')),
    s.armor.notes.length > 0 && h('ul', {}, s.armor.notes.map((n) => h('li', { class: 'muted' }, n)))];
}

function masteryEditor(c, s) {
  const m = s.masteries;
  if (!m.allowed) return null;
  const cls = RULES.classes[c.className];
  const proficient = Object.entries(RULES.weapons).filter(([, w]) => w.category.startsWith('simple') || cls.weapons === 'martial'
    || (cls.martialIf || []).some((p) => w.properties.some((x) => x.startsWith(p)))).map(([n]) => n);
  const save = (masteries) => run(async () => reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { masteries })));
  return h('details', {}, h('summary', {}, `Weapon mastery (${m.chosen.length}/${m.allowed})`),
    h('div', { style: 'display:flex;flex-wrap:wrap;gap:4px 12px' }, proficient.map((n) => h('label', { class: 'inline', title: RULES.masteries[RULES.mastery[n]] },
      h('input', { type: 'checkbox', checked: m.chosen.includes(n) || false, disabled: !m.chosen.includes(n) && m.chosen.length >= m.allowed || false,
        onchange: (e) => save(e.target.checked ? [...m.chosen, n] : m.chosen.filter((x) => x !== n)) }), `${n} (${RULES.mastery[n]})`))));
}

let SPELL_CATALOG = null;
const loadSpells = async () => (SPELL_CATALOG ||= await api('GET', '/api/ruleset/spells'));

function spellsSection(v) {
  const c = v.character, s = v.sheet, sc = s.spellcasting;
  const used = c.slotsUsed || {};
  const pips = (n, max) => '●'.repeat(Math.max(0, max - n)) + '○'.repeat(Math.min(n, max));
  const saveList = (spells) => run(async () => reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { spells })));
  const cast = (sp, slotLevel, free) => run(async () => {
    const o = rollOpts();
    const r = await api('POST', `/api/characters/${c.id}/cast`, { spellId: sp.id, slotLevel, free, mode: o.mode, visibility: o.visibility, crit: !!o.crit });
    state.lastRolls = r.rolls;
    state.lastNote = `${c.name} cast ${sp.name}${free ? ' (Magic Initiate, no slot)' : slotLevel ? ` with a level ${slotLevel} slot` : ''}.`;
    await reloadCharacter(r);
  });
  if (!sc) return h('section', {}, h('h3', {}, 'Spellcasting'), h('p', { class: 'muted' }, `${c.className}s do not cast spells.`));
  const ready = v.spells.filter((sp) => sp.prepared);
  const cantrips = ready.filter((sp) => sp.level === 0).length;
  const spells = [...v.spells].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const summary = (sp) => [sp.attack === 'attack' ? 'spell attack' : sp.attack === 'save' ? `${sp.saveAbility.toUpperCase()} save` : '',
    sp.castingTime, sp.range, sp.components, sp.duration, sp.concentration ? 'Concentration' : '', sp.ritual ? 'Ritual' : ''].filter(Boolean).join(' · ');
  const formula = (f) => [f.damage && `${f.damage} damage`, f.heal && `${f.heal} healing`].filter(Boolean).join(', ');
  return h('section', {}, h('h3', {}, 'Spellcasting'),
    h('p', {}, `${sc.ability.toUpperCase()} · Save DC ${sc.saveDC} · `,
      h('button', { class: 'link', onclick: () => run(() => rollCheck(c, 'spellattack')) }, `Spell attack ${signed(sc.attackBonus)}`),
      ` · Cantrips ${cantrips}/${sc.cantripsMax} · Prepared ${ready.length - cantrips}/${sc.preparedMax}`),
    sc.pact
      ? h('p', {}, `Pact slots (level ${sc.pact.level}): `, h('span', { 'aria-label': `${sc.pact.count - (used.pact || 0)} of ${sc.pact.count} left` }, pips(used.pact || 0, sc.pact.count)))
      : sc.slots.length > 0 && h('p', {}, sc.slots.map((max, i) => h('span', { style: 'margin-right:12px', 'aria-label': `level ${i + 1}: ${max - (used[i + 1] || 0)} of ${max} left` }, `L${i + 1} ${pips(used[i + 1] || 0, max)}`))),
    sc.freeCast && h('p', { class: 'muted' }, `${sc.freeCast}: one level 1 spell without a slot per long rest (${used.free ? 'used' : 'available'}).`),
    spells.length ? h('ul', { style: 'padding-left:0;list-style:none' }, spells.map((sp) => h('li', { style: 'margin:6px 0' },
      h('label', { class: 'inline', title: 'Prepared' }, h('input', { type: 'checkbox', checked: sp.prepared || false, 'aria-label': `${sp.name} prepared`,
        onchange: () => saveList(c.spells.map((e) => (e.id === sp.id ? { ...e, prepared: !e.prepared } : e))) }), h('strong', {}, sp.name)),
      ` — ${sp.level ? `level ${sp.level}` : 'cantrip'}${sp.school ? ` ${sp.school.toLowerCase()}` : ''}${sp.srd ? '' : ' (custom)'}`,
      h('div', { class: 'muted' }, summary(sp)),
      sp.prepared && h('div', {}, Object.entries(sp.at).map(([lvl, f]) => h('button', { class: 'link', style: 'margin-right:10px',
        'aria-label': `Cast ${sp.name}${sp.level ? ` with a level ${lvl} slot` : ''}`, onclick: () => cast(sp, sp.level && !sc.pact ? +lvl : undefined) },
        `Cast${sp.level ? ` L${lvl}` : ''}${formula(f) ? ` · ${formula(f)}` : ''}`)),
        sc.freeCast && sp.level === 1 && h('button', { class: 'link', onclick: () => cast(sp, undefined, true) }, 'Cast free (Magic Initiate)')),
      h('details', {}, h('summary', {}, 'Description'), h('p', { style: 'white-space:pre-wrap' }, sp.description || '—'),
        sp.higherLevel && h('p', { style: 'white-space:pre-wrap' }, h('em', {}, 'At higher levels. '), sp.higherLevel)),
      h('button', { class: 'link', onclick: () => saveList(c.spells.filter((e) => e.id !== sp.id)) }, 'remove'))))
      : h('p', { class: 'muted' }, 'No spells yet.'),
    spellPicker(c),
    h('details', {}, h('summary', {}, 'Add a custom spell'),
      h('form', { onsubmit: onSubmit((f) => saveList([...c.spells, { name: f.name, level: +f.level, attack: f.attack, saveAbility: f.attack === 'save' ? f.saveAbility : undefined,
          damage: f.damage || undefined, damageType: f.damageType, notes: f.notes }])) },
        field('Name', h('input', { name: 'name', required: true })),
        field('Level', h('select', { name: 'level' }, h('option', { value: 0 }, 'cantrip'), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => h('option', { value: l }, l)))),
        field('Resolved by', h('select', { name: 'attack' }, h('option', { value: 'none' }, 'nothing to roll'), h('option', { value: 'attack' }, 'spell attack'), h('option', { value: 'save' }, 'saving throw'))),
        field('Save', h('select', { name: 'saveAbility' }, options(['str', 'dex', 'con', 'int', 'wis', 'cha'], 'dex'))),
        field('Damage (optional)', h('input', { name: 'damage', placeholder: '3d6', size: 6 })),
        field('Type', h('input', { name: 'damageType', placeholder: 'fire', size: 8 })),
        h('label', { style: 'width:100%' }, 'Notes', h('input', { name: 'notes', placeholder: 'range, duration, higher-level effect…' })),
        h('button', {}, 'Add spell'))));
}

function spellPicker(c) {
  const results = h('ul', { style: 'max-height:260px;overflow:auto;padding-left:18px' });
  const known = new Set(c.spells.map((e) => e.srd).filter(Boolean));
  const form = h('form', { onsubmit: (e) => e.preventDefault() },
    field('Search', h('input', { name: 'q', type: 'search', placeholder: 'fire, heal, charm…', oninput: () => draw() })),
    field('Class list', h('select', { name: 'cls', onchange: () => draw() }, h('option', { value: c.className }, c.className), h('option', { value: '' }, 'all classes'),
      Object.keys(RULES.classes).filter((k) => k !== c.className).map((k) => h('option', { value: k }, k)))),
    field('Level', h('select', { name: 'lvl', onchange: () => draw() }, h('option', { value: '' }, 'any'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => h('option', { value: l }, l ? `level ${l}` : 'cantrip')))));
  const add = (name) => run(async () => {
    try { await reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { spells: [...c.spells, { srd: name }] })); }
    catch (e) { // over the limit: keep it in the list, unprepared
      if (e.status !== 400) throw e;
      await reloadCharacter(await api('PATCH', `/api/characters/${c.id}`, { spells: [...c.spells, { srd: name, prepared: false }] }));
      state.lastNote = `${name} added but not prepared: ${e.message}`;
      showRolls([]);
    }
  });
  function draw() {
    if (!SPELL_CATALOG) return;
    const f = Object.fromEntries(new FormData(form));
    const q = f.q.trim().toLowerCase();
    const hits = SPELL_CATALOG.filter((sp) => (!f.cls || sp.classes.includes(f.cls)) && (f.lvl === '' || sp.level === +f.lvl)
      && (!q || sp.name.toLowerCase().includes(q) || sp.description.toLowerCase().includes(q))).slice(0, 60);
    results.replaceChildren(...(hits.length ? hits.map((sp) => h('li', {}, `${sp.name} — ${sp.level ? `level ${sp.level}` : 'cantrip'} ${sp.school.toLowerCase()} `,
      known.has(sp.name) ? h('span', { class: 'muted' }, '(on sheet)') : h('button', { class: 'link', onclick: () => add(sp.name) }, 'add'))) : [h('li', { class: 'muted' }, 'No matches.')]));
  }
  return h('details', { ontoggle: (e) => e.target.open && run(async () => { await loadSpells(); draw(); }) }, h('summary', {}, 'Add from the SRD spell list'), form, results);
}

function renderSheet() {
  const v = state.character, gm = state.world.role === 'gm';
  const back = h('button', { class: 'link', onclick: () => run(() => go(state.loc.location.id)) }, `‹ ${state.loc.location.name}`); // reload: the world may have changed meanwhile
  if (v.access !== 'full') {
    return $app.append(h('section', {}, back, h('h2', {}, v.name),
      v.portraitUrl && h('img', { src: v.portraitUrl, alt: `Portrait of ${v.name}`, style: 'max-width:160px;border-radius:8px' }),
      h('p', {}, `Level ${v.level} ${v.species} ${v.className} · played by ${v.ownerName}`),
      v.conditions.length > 0 && h('p', {}, `Conditions: ${v.conditions.join(', ')}`),
      v.journal.length > 0 && [h('h3', {}, 'Shared journal'), h('ul', {}, [...v.journal].reverse().map((e) => h('li', {}, h('span', { class: 'muted' }, `${new Date(e.at).toLocaleDateString()} · `), e.text)))]));
  }
  const c = v.character, s = v.sheet, adv = v.advancement;
  const roll = (chk, label) => h('button', { class: 'link', onclick: () => run(() => rollCheck(c, chk)), 'aria-label': `Roll ${label}` }, label);
  const hpForm = h('form', { onsubmit: (e) => e.preventDefault() },
    field('Amount', h('input', { name: 'n', type: 'number', min: 0, max: 10000, value: 1, size: 4 })),
    ['damage', 'heal', 'temp'].map((k) => h('button', { onclick: (e) => run(async () => {
      const fd = new FormData(e.target.form);
      await reloadCharacter(await api('POST', `/api/characters/${c.id}/hp`, { [k]: +fd.get('n'), ...(k === 'damage' && fd.get('critical') && { critical: true }) }));
    }) }, k === 'temp' ? 'Set temp HP' : k[0].toUpperCase() + k.slice(1))),
    c.hp.current === 0 && check('Critical hit (two failed death saves)', 'critical'));
  const ds = c.deathSaves;
  const dying = c.hp.current === 0 && h('div', { class: 'note', role: 'status' },
    h('strong', {}, ds.dead ? `${c.name} is dead.` : ds.stable ? `${c.name} is stable at 0 HP.` : `${c.name} is dying.`), ' ',
    `Successes ${'✓'.repeat(ds.successes)}${'○'.repeat(3 - ds.successes)} · Failures ${'✗'.repeat(ds.failures)}${'○'.repeat(3 - ds.failures)} `,
    !ds.dead && !ds.stable && h('button', { onclick: () => run(async () => {
      const r = await api('POST', `/api/characters/${c.id}/death-save`, { visibility: rollOpts().visibility });
      state.lastRolls = r.rolls; state.lastNote = null; await reloadCharacter(r);
    }) }, 'Roll death save'));

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
    progress, rollControls()));

  if (v.pendingChoices.length) $app.append(choicesPanel(v));
  $app.append(h('div', { class: 'row' }, attacksSection(c, s), spellsSection(v)));
  $app.append(featuresSection(v));
  $app.append(h('div', { class: 'row' },
    h('section', {},
      h('h3', {}, `Hit points ${c.hp.current} / ${s.maxHp}${c.hp.temp ? ` (+${c.hp.temp} temp)` : ''}`),
      h('progress', { max: s.maxHp, value: c.hp.current, 'aria-label': 'Hit points' }), hpForm,
      dying,
      h('form', { onsubmit: (e) => e.preventDefault(), style: 'align-items:end' },
        field(`Hit Point Dice to spend (${v.level - c.hitDiceUsed}/${v.level} ${s.hitDie} left)`, h('select', { name: 'hitDice' },
          [...Array(v.level - c.hitDiceUsed + 1).keys()].map((n) => h('option', { value: n }, n)))),
        ['short', 'long'].map((k) => h('button', { onclick: (e) => run(async () => {
          const r = await api('POST', `/api/characters/${c.id}/rest`, { kind: k, hitDice: k === 'short' ? +new FormData(e.target.form).get('hitDice') : undefined });
          state.lastRolls = r.rolls; state.lastNote = `${c.name} finished a ${k} rest.`; await reloadCharacter(r);
        }) }, `${k[0].toUpperCase() + k.slice(1)} rest`))),
      h('p', {}, `AC ${s.armorClass} (${s.armor.label}) · Speed ${s.speed} ft · Proficiency ${signed(s.proficiencyBonus)} · Passive Perception ${s.passivePerception} · Hit die ${s.hitDie} · `,
        roll('initiative', `Initiative ${signed(s.initiative)}`)),
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
      journalEditor(c),
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

function choicesPanel(v) {
  const c = v.character;
  const send = (body) => run(async () => reloadCharacter(await api('POST', `/api/characters/${c.id}/choices`, body)));
  const owned = new Set(c.feats.map((f) => f.replace(/ \((Cleric|Druid|Wizard)\)$/, '')));
  const abil = (name) => h('select', { name }, h('option', { value: '' }, '—'), RULES.abilities.map((a) => h('option', { value: a }, ABIL[a])));
  const featForm = (ch, types) => {
    const list = RULES.feats.filter((f) => types.includes(f.type) && f.minLevel <= v.level && (f.name === 'Ability Score Improvement' || f.name === 'Skilled' || f.name === 'Magic Initiate' || !owned.has(f.name))
      && (f.type !== 'fighting-style' || v.features.some((x) => x.name === 'Fighting Style')));
    const desc = h('p', { class: 'muted', style: 'white-space:pre-wrap;width:100%' });
    const show = (name) => { desc.textContent = (list.find((f) => f.name === name) || {}).description || ''; };
    const form = h('form', { onsubmit: onSubmit((f) => {
        const increases = {};
        if (f.a1) increases[f.a1] = (increases[f.a1] || 0) + Number(f.n1);
        if (f.a2) increases[f.a2] = (increases[f.a2] || 0) + 1;
        const skills = [f.s1, f.s2, f.s3].filter(Boolean);
        send({ level: ch.level, kind: ch.kind, feat: f.feat, list: f.list || undefined, increases: Object.keys(increases).length ? increases : undefined, skills: skills.length ? skills : undefined });
      }) },
      field('Feat', h('select', { name: 'feat', onchange: (e) => show(e.target.value) }, list.map((f) => h('option', { value: f.name }, f.name)))),
      ch.kind !== 'fightingStyle' && [field('Increase', abil('a1')), field('by', h('select', { name: 'n1' }, h('option', { value: 2 }, '+2'), h('option', { value: 1 }, '+1'))),
        field('and +1 to', abil('a2'))],
      ch.kind === 'feat' && [field('Magic Initiate list', h('select', { name: 'list' }, h('option', { value: '' }, '—'), options(['Cleric', 'Druid', 'Wizard']))),
        ['s1', 's2', 's3'].map((k) => field('Skilled: skill', h('select', { name: k }, h('option', { value: '' }, '—'), Object.keys(RULES.skills).filter((x) => !c.skills.includes(x)).map((x) => h('option', { value: x }, x)))))],
      h('button', {}, 'Choose'), desc);
    show(list[0] && list[0].name);
    return form;
  };
  return h('section', { class: 'note' }, h('h3', {}, 'Level-up choices waiting'),
    v.pendingChoices.map((ch) => h('div', {}, h('p', {}, h('strong', {}, `Level ${ch.level}: `),
      { subclass: 'choose your subclass', fightingStyle: 'choose a Fighting Style', feat: 'Ability Score Improvement or another feat', boon: 'choose an Epic Boon' }[ch.kind]),
      ch.kind === 'subclass'
        ? [h('p', { class: 'muted' }, RULES.subclasses[c.className].summary), h('button', { onclick: () => send({ level: ch.level, kind: 'subclass', subclass: RULES.subclasses[c.className].name }) }, `Become ${RULES.subclasses[c.className].name}`)]
        : featForm(ch, ch.kind === 'fightingStyle' ? ['fighting-style'] : ch.kind === 'boon' ? ['epic-boon'] : ['general', 'origin', 'fighting-style']))));
}

function featuresSection(v) {
  return h('section', {}, h('h3', {}, `Features${v.character.subclass ? ` · ${v.character.subclass}` : ''}`),
    v.features.map((f) => h('details', {}, h('summary', {}, `Level ${f.level} · ${f.name}${f.subclass ? ` (${f.subclass})` : ''}`), h('p', { style: 'white-space:pre-wrap' }, f.description))),
    h('h3', {}, 'Feats'),
    v.featDetails.map((f) => h('details', {}, h('summary', {}, f.name), h('p', { style: 'white-space:pre-wrap' }, f.description))));
}

function journalEditor(c) {
  return [h('h3', {}, 'Journal'),
    c.journal.length ? h('ul', {}, [...c.journal].reverse().map((e) => h('li', {}, h('span', { class: 'muted' }, `${new Date(e.at).toLocaleString()} · ${e.visibility === 'party' ? 'shared with the party' : 'private'} · `),
      h('span', { style: 'white-space:pre-wrap' }, e.text), ' ',
      h('button', { class: 'link', onclick: () => run(async () => reloadCharacter(await api('DELETE', `/api/journal-entries/${e.id}`))) }, 'delete'))))
      : h('p', { class: 'muted' }, 'No entries yet.'),
    h('form', { onsubmit: onSubmit(async (f, form) => { const r = await api('POST', `/api/characters/${c.id}/journal`, f); form.reset(); await reloadCharacter(r); }) },
      h('label', { style: 'width:100%' }, 'New entry', h('textarea', { name: 'text', required: true })),
      field('Visible to', h('select', { name: 'visibility' }, h('option', { value: 'private' }, 'me and the GM'), h('option', { value: 'party' }, 'the party'))),
      h('button', {}, 'Add entry'))];
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
