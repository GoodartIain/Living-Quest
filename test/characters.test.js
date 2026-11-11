// Milestone 4 acceptance: characters progress by the GM-selected method; authorised changes reach their tokens.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../rulesets/srd-5.2.1.js');
const dice = require('../dice.js');
const { boot } = require('./helpers.js');

// Dwarf Fighter (Soldier), standard array; Soldier raises STR +2, CON +1.
const fighter = {
  species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
  baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 },
  classSkills: ['Perception', 'Survival'],
};

test('SRD 5.2.1 creation rules and derived numbers', () => {
  const c = rules.create(fighter);
  assert.deepEqual(c.abilities, { str: 17, dex: 14, con: 14, int: 8, wis: 12, cha: 10 });
  assert.deepEqual(c.skills, ['Athletics', 'Intimidation', 'Perception', 'Survival']);
  const s1 = rules.derive(c, 1);
  assert.equal(s1.maxHp, 13, 'd10 + CON 2 + Dwarven Toughness 1');
  assert.equal(rules.derive(c, 2).maxHp, 22, '+ (6 + 2 + 1) per level');
  assert.equal(s1.saves.str, 5);
  assert.equal(s1.saves.dex, 2, 'not proficient');
  assert.equal(s1.skills.Athletics, 5);
  assert.equal(s1.passivePerception, 13);
  assert.equal(s1.initiative, 2);
  assert.equal(rules.derive(c, 5).proficiencyBonus, 3);
  assert.equal(rules.derive(rules.create({ ...fighter, background: 'Criminal', backgroundBonus: { dex: 1, con: 1, int: 1 }, classSkills: ['Perception', 'Athletics'] }), 1).initiative, 4, 'Alert adds proficiency');
  assert.deepEqual([0, 299, 300, 899, 900, 355000].map(rules.xpLevel), [1, 1, 2, 2, 3, 20]);

  const bad = (patch, msg) => assert.throws(() => rules.create({ ...fighter, ...patch }), (e) => e.status === 400 && msg.test(e.message));
  bad({ baseScores: { ...fighter.baseScores, str: 16 } }, /standard array/);
  bad({ backgroundBonus: { str: 2, wis: 1 } }, /can only raise/);
  bad({ backgroundBonus: { str: 2, con: 2 } }, /\+2\/\+1/);
  bad({ classSkills: ['Athletics', 'Perception'] }, /already proficient/);
  bad({ classSkills: ['Arcana', 'Perception'] }, /not an option/);
  bad({ classSkills: ['Perception'] }, /exactly 2/);
  bad({ species: 'Elf' }, /Elf: choose exactly 1/);
  assert.ok(rules.create({ ...fighter, abilityMethod: 'pointbuy', baseScores: { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 } }), '27 points exactly');
  bad({ abilityMethod: 'pointbuy', baseScores: { str: 15, dex: 15, con: 15, int: 9, wis: 8, cha: 8 } }, /spends 28 of 27/);
});

test('dice: formulas, advantage, validation', () => {
  const seq = [4, 17, 3, 6, 2];
  let i = 0;
  const r = dice.roll('1d20 + 2d6 - 1', 'advantage', () => seq[i++]);
  assert.equal(r.total, 17 + 3 + 6 - 1);
  assert.deepEqual(r.parts[0], { sign: 1, dice: '1d20', rolls: [4, 17], kept: [17], sum: 17 });
  i = 0;
  assert.equal(dice.roll('1d20+1', 'disadvantage', () => seq[i++]).total, 5);
  for (const f of ['', '1d0', '2d6+', '1d20 1d4', '101d6', 'd20x']) assert.throws(() => dice.roll(f), (e) => e.status === 400, f);
  assert.throws(() => dice.roll('2d20', 'advantage'), /exactly one 1d20/);
  for (let n = 0; n < 200; n++) { const t = dice.roll('1d6').total; assert.ok(t >= 1 && t <= 6); }
});

test('XP and milestone advancement, with sheets and tokens in sync', async (t) => {
  const { call, ok, listen, close } = await boot();
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return close(); });
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'XP', }, gm);
  const join = async (name, c = camp, role = 'player') => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${c.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const pat = await join('Pat');
  const ana = await join('Ana');
  const viv = await join('Viv', camp, 'spectator');
  const outsider = await user('Out');

  // Guided creation is validated on the server.
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/characters`, { ...fighter, name: 'Bad', classSkills: ['Arcana', 'Perception'] }, pat)).status, 400);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/characters`, { ...fighter, name: 'Nope' }, viv)).status, 403);
  const created = await ok('POST', `/api/campaigns/${camp.id}/characters`, { ...fighter, name: 'Brann', backstory: 'Ex-soldier.' }, pat);
  const brann = created.character;
  assert.equal(created.level, 1);
  assert.equal(brann.hp.current, 13);
  const anaChar = (await ok('POST', `/api/campaigns/${camp.id}/characters`, {
    name: 'Ilse', species: 'Elf', className: 'Wizard', background: 'Sage', abilityMethod: 'pointbuy',
    baseScores: { str: 8, dex: 14, con: 14, int: 15, wis: 12, cha: 8 }, backgroundBonus: { int: 2, con: 1 },
    classSkills: ['Investigation', 'Medicine'], speciesSkills: ['Perception'] }, ana)).character;

  // Who sees what.
  assert.equal((await ok('GET', `/api/characters/${brann.id}`, null, ana)).access, 'summary');
  assert.equal((await ok('GET', `/api/characters/${brann.id}`, null, ana)).abilities, undefined);
  assert.equal((await ok('GET', `/api/characters/${brann.id}`, null, viv)).access, 'summary');
  assert.equal((await call('GET', `/api/characters/${brann.id}`, null, outsider)).status, 404);
  assert.equal((await call('PATCH', `/api/characters/${brann.id}`, { name: 'Hacked' }, ana)).status, 403);

  // Token linked to the character: owner controls it; HP only for owner and GM.
  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 5, y: 5 }, gm);
  const scene = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Gate', visibility: 'party' }, gm);
  const token = await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'ignored', x: 1, y: 1, characterId: brann.id }, gm);
  const [patLive, anaLive, gmLive] = await Promise.all([listen(scene.id, pat), listen(scene.id, ana), listen(scene.id, gm)]);
  streams.push(patLive, anaLive, gmLive);
  const tok = (m) => m.data.tokens.find((x) => x.id === token.id);
  const first = tok(await patLive.until(() => true));
  assert.equal(first.name, 'Brann');
  assert.equal(first.mine, true, 'owner controls the token by default');
  assert.deepEqual(first.character.hp, { current: 13, temp: 0, max: 13 });
  assert.equal(tok(await anaLive.until(() => true)).character.hp, undefined, 'other players do not see HP');

  // Damage, temp HP, conditions and renames flow to the token.
  await ok('POST', `/api/characters/${brann.id}/hp`, { temp: 5 }, pat);
  await ok('POST', `/api/characters/${brann.id}/hp`, { damage: 8 }, pat);
  await patLive.until((m) => tok(m).character.hp.current === 10 && tok(m).character.hp.temp === 0);
  assert.equal((await call('POST', `/api/characters/${brann.id}/hp`, { damage: 1 }, ana)).status, 403);
  assert.equal((await call('POST', `/api/characters/${brann.id}/hp`, { damage: 1, heal: 1 }, pat)).status, 400);
  await ok('PATCH', `/api/characters/${brann.id}`, { conditions: ['Poisoned'], name: 'Brann Ironhand' }, gm);
  await anaLive.until((m) => tok(m).name === 'Brann Ironhand' && tok(m).character.conditions.includes('Poisoned'));
  assert.equal((await call('PATCH', `/api/characters/${brann.id}`, { conditions: ['Sleepy'] }, pat)).status, 400);
  await ok('PATCH', `/api/characters/${brann.id}`, { inventory: [{ name: 'Longsword', qty: 1 }, { name: 'Rations', qty: 5, notes: 'one day each' }], currency: { gp: 15 } }, pat);
  assert.equal((await ok('GET', `/api/characters/${brann.id}`, null, pat)).character.inventory[1].qty, 5);

  // XP mode, GM confirms level-ups.
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/xp`, { amount: 300, reason: 'x' }, pat)).status, 403);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/milestone`, { reason: 'x' }, gm)).status, 409);
  const award = await ok('POST', `/api/campaigns/${camp.id}/xp`, { amount: 300, category: 'combat', reason: 'Gate ambush' }, gm);
  assert.deepEqual(award.map((a) => [a.xp, a.level, a.pendingLevels]), [[300, 1, 1], [300, 1, 1]], 'party award, nobody levelled without approval');
  assert.equal((await call('POST', `/api/characters/${brann.id}/level-up`, null, pat)).status, 403);
  const up = await ok('POST', `/api/characters/${brann.id}/level-up`, null, gm);
  assert.equal(up.level, 2);
  assert.equal(up.character.hp.current, 10 + 9, 'HP rise with the new maximum');
  assert.equal((await call('POST', `/api/characters/${brann.id}/level-up`, null, gm)).status, 409, 'no pending level left');
  await patLive.until((m) => tok(m).character.level === 2 && tok(m).character.hp.max === 22);

  // Automatic level-ups when the GM chooses it; individual awards.
  await ok('PATCH', `/api/campaigns/${camp.id}/advancement`, { levelUp: 'auto' }, gm);
  const auto = await ok('POST', `/api/campaigns/${camp.id}/xp`, { amount: 2400, category: 'quest', reason: 'Cleared the crypt', characterIds: [anaChar.id] }, gm);
  assert.deepEqual(auto.map((a) => [a.xp, a.level]), [[2700, 4]], 'Ilse jumps from 1 to 4');
  assert.equal((await ok('GET', `/api/characters/${brann.id}`, null, pat)).xp, 300, 'Brann not included');
  const hist = (await ok('GET', `/api/characters/${anaChar.id}`, null, ana)).history;
  assert.deepEqual(hist.map((h) => [h.kind, h.auto]), [['xp', false], ['xp', false], ['level', true], ['level', true], ['level', true]]);

  // Switching to milestones keeps levels; then milestones drive levels.
  assert.equal((await call('PATCH', `/api/campaigns/${camp.id}/advancement`, { mode: 'milestone' }, gm)).status, 409);
  await ok('PATCH', `/api/campaigns/${camp.id}/advancement`, { mode: 'milestone', confirm: true }, gm);
  assert.equal((await ok('GET', `/api/characters/${anaChar.id}`, null, ana)).level, 4);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/xp`, { amount: 10, reason: 'x' }, gm)).status, 409);
  const ms = await ok('POST', `/api/campaigns/${camp.id}/milestone`, { reason: 'Saved Greyhaven' }, gm);
  assert.deepEqual(ms.map((m) => m.level), [3, 5]);

  // Rolls: server-generated, scoped by visibility, shown in the scene.
  const r = await ok('POST', `/api/worlds/${world.id}/rolls`, { characterId: brann.id, check: 'skill:Athletics', sceneId: scene.id }, pat);
  assert.equal(r.formula, '1d20+5');
  assert.ok(r.total >= 6 && r.total <= 25);
  await anaLive.until((m) => m.data.rolls.some((x) => x.id === r.id));
  const secret = await ok('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d20', visibility: 'private', sceneId: scene.id }, pat);
  const blind = await ok('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d100', visibility: 'gm', sceneId: scene.id }, gm);
  await gmLive.until((m) => [secret.id, blind.id].every((rid) => m.data.rolls.some((x) => x.id === rid)));
  const anaRolls = (await ok('GET', `/api/worlds/${world.id}/rolls`, null, ana)).map((x) => x.id);
  assert.deepEqual(anaRolls, [r.id]);
  const patRolls = (await ok('GET', `/api/worlds/${world.id}/rolls`, null, pat)).map((x) => x.id);
  assert.deepEqual(patRolls, [secret.id, r.id]);
  assert.equal((await call('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d20', visibility: 'gm' }, pat)).status, 403);
  assert.equal((await call('POST', `/api/worlds/${world.id}/rolls`, { characterId: brann.id, check: 'skill:Stealth' }, ana)).status, 403);
  assert.equal((await call('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d20' }, viv)).status, 403, 'spectators watch, not roll');
  for (const s of [anaLive]) assert.ok(!JSON.stringify(s.msgs).includes(secret.id) && !JSON.stringify(s.msgs).includes(blind.id));
});

test('attacks and spells: bonuses from the sheet, slots, pact magic, rests', async (t) => {
  // Rules: proficiency by class, finesse/ranged abilities, slot tables.
  const rogue = { ...rules.create({ species: 'Human', className: 'Rogue', background: 'Criminal', abilityMethod: 'standard',
    baseScores: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 }, backgroundBonus: { dex: 2, int: 1 },
    classSkills: ['Acrobatics', 'Deception', 'Insight', 'Perception'], speciesSkills: ['Survival'] }),
  weapons: [{ id: 'a', weapon: 'Rapier' }, { id: 'b', weapon: 'Longsword' }, { id: 'c', weapon: 'Hand Crossbow' }] };
  const atk = Object.fromEntries(rules.derive(rogue, 1).attacks.map((a) => [a.name, [a.ability, a.proficient, a.toHit, a.damage]]));
  assert.deepEqual(atk, {
    'Unarmed Strike': ['str', true, 1, '1-1'], Rapier: ['dex', true, 5, '1d8+3'],
    Longsword: ['str', false, -1, '1d8-1'], 'Hand Crossbow': ['dex', true, 5, '1d6+3'] });
  const sc = (className, level) => rules.derive({ ...rogue, className }, level).spellcasting;
  assert.equal(sc('Rogue', 5), null);
  assert.deepEqual(sc('Paladin', 1).slots, [2]);
  assert.deepEqual(sc('Wizard', 3).slots, [4, 2]);
  assert.deepEqual(sc('Wizard', 20).slots, [4, 3, 3, 3, 3, 2, 2, 1, 1]);
  assert.deepEqual(sc('Warlock', 11).pact, { count: 3, level: 5 });
  assert.deepEqual([sc('Wizard', 1).saveDC, sc('Wizard', 1).attackBonus], [12, 4], 'INT 14 (+2), proficiency +2');

  const { call, ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const ana = (await ok('POST', '/api/users', { name: 'Ana' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'Aster', advancement: 'milestone' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, ana);
  const make = async (b) => (await ok('POST', `/api/campaigns/${camp.id}/characters`, b, ana)).character;
  const fighterC = await make({ ...fighter, name: 'Brann' });
  const wiz = await make({ name: 'Ilse', species: 'Gnome', className: 'Wizard', background: 'Sage', abilityMethod: 'standard',
    baseScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, backgroundBonus: { int: 2, con: 1 }, classSkills: ['Investigation', 'Medicine'] });
  const lock = await make({ name: 'Vex', species: 'Tiefling', className: 'Warlock', background: 'Acolyte', abilityMethod: 'standard',
    baseScores: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 }, backgroundBonus: { cha: 2, wis: 1 }, classSkills: ['Arcana', 'Deception'] });
  const roll = (b) => call('POST', `/api/worlds/${world.id}/rolls`, b, ana);

  // Weapons: only SRD weapons; bonuses are computed, never sent by the client.
  assert.equal((await call('PATCH', `/api/characters/${fighterC.id}`, { weapons: [{ weapon: 'Lightsaber' }] }, ana)).status, 400);
  const armed = await ok('PATCH', `/api/characters/${fighterC.id}`, { weapons: [{ weapon: 'Longsword' }, { weapon: 'Longbow' }] }, ana);
  const [sword, bow] = armed.sheet.attacks.slice(1);
  assert.equal((await roll({ characterId: fighterC.id, check: `attack:${sword.id}` })).body.formula, '1d20+5');
  assert.equal((await roll({ characterId: fighterC.id, check: `damage:${sword.id}` })).body.formula, '1d8+3');
  assert.equal((await roll({ characterId: fighterC.id, check: `damage:${sword.id}`, versatile: true })).body.formula, '1d10+3');
  assert.equal((await roll({ characterId: fighterC.id, check: `damage:${sword.id}`, crit: true })).body.formula, '2d8+3');
  assert.equal((await roll({ characterId: fighterC.id, check: `attack:${bow.id}` })).body.formula, '1d20+4', 'DEX 14 +2, proficient');
  assert.equal((await roll({ characterId: fighterC.id, check: `damage:${bow.id}`, versatile: true })).status, 400);
  assert.equal((await roll({ characterId: fighterC.id, check: 'attack:nope' })).status, 404);
  assert.equal((await roll({ characterId: fighterC.id, check: 'spellattack' })).status, 409);

  // Spells: validated list; casting spends slots and rolls from the sheet's DC and attack bonus.
  assert.equal((await call('PATCH', `/api/characters/${wiz.id}`, { spells: [{ name: 'X', level: 10 }] }, ana)).status, 400);
  assert.equal((await call('PATCH', `/api/characters/${wiz.id}`, { spells: [{ name: 'X', level: 1, damage: '3d' }] }, ana)).status, 400);
  assert.equal((await call('PATCH', `/api/characters/${wiz.id}`, { spells: [{ name: 'X', level: 1, attack: 'save' }] }, ana)).status, 400, 'save needs an ability');
  const withSpells = await ok('PATCH', `/api/characters/${wiz.id}`, { spells: [
    { name: 'Fire Bolt', level: 0, attack: 'attack', damage: '1d10', damageType: 'fire' },
    { name: 'Burning Hands', level: 1, attack: 'save', saveAbility: 'dex', damage: '3d6', damageType: 'fire' },
    { name: 'Shield', level: 1 }] }, ana);
  const [bolt, hands, shield] = withSpells.character.spells;
  const cast = (c, b) => call('POST', `/api/characters/${c.id}/cast`, b, ana);
  const b1 = (await cast(wiz, { spellId: bolt.id, crit: true })).body;
  assert.deepEqual(b1.rolls.map((r) => r.formula), ['1d20+5', '2d10']);
  assert.deepEqual(b1.character.slotsUsed, {}, 'cantrips are free');
  const b2 = (await cast(wiz, { spellId: hands.id })).body;
  assert.match(b2.rolls[0].label, /DC 13 DEX save/);
  assert.deepEqual(b2.character.slotsUsed, { 1: 1 });
  assert.equal((await cast(wiz, { spellId: shield.id })).body.rolls.length, 0, 'no roll for a utility spell');
  assert.equal((await cast(wiz, { spellId: shield.id })).status, 409, 'level 1 wizard has 2 first-level slots');
  assert.equal((await cast(wiz, { spellId: hands.id, slotLevel: 2 })).status, 409, 'no second-level slots yet');
  await ok('POST', `/api/campaigns/${camp.id}/milestone`, { reason: 'Up', characterIds: [wiz.id] }, gm);
  await ok('POST', `/api/campaigns/${camp.id}/milestone`, { reason: 'Up', characterIds: [wiz.id] }, gm);
  const up = (await cast(wiz, { spellId: hands.id, slotLevel: 2 })).body;
  assert.match(up.rolls[0].label, /at level 2/);
  assert.deepEqual(up.character.slotsUsed, { 1: 2, 2: 1 });
  assert.equal((await cast(fighterC, { spellId: 'x' })).status, 409);
  const rested = await ok('POST', `/api/characters/${wiz.id}/rest`, { kind: 'long' }, ana);
  assert.deepEqual(rested.character.slotsUsed, {});
  assert.equal(rested.character.hp.current, rested.sheet.maxHp);

  // Pact Magic: one level-1 slot at level 1, back on a short rest.
  const hex = (await ok('PATCH', `/api/characters/${lock.id}`, { spells: [{ name: 'Hex', level: 1 }, { name: 'Darkness', level: 2 }] }, ana)).character.spells;
  assert.equal((await cast(lock, { spellId: hex[1].id })).status, 409, 'pact slots are level 1');
  await ok('POST', `/api/characters/${lock.id}/cast`, { spellId: hex[0].id }, ana);
  assert.equal((await cast(lock, { spellId: hex[0].id })).status, 409);
  await ok('POST', `/api/characters/${lock.id}/rest`, { kind: 'short' }, ana);
  await ok('POST', `/api/characters/${lock.id}/cast`, { spellId: hex[0].id }, ana);

  // Only the owner or GM may cast, and a refused cast spends nothing.
  const other = (await ok('POST', '/api/users', { name: 'Out' })).token;
  assert.equal((await call('POST', `/api/characters/${wiz.id}/cast`, { spellId: hands.id }, other)).status, 404);
  assert.equal((await cast(wiz, { spellId: hands.id, sceneId: 'missing' })).status, 404);
  assert.deepEqual((await ok('GET', `/api/characters/${wiz.id}`, null, ana)).character.slotsUsed, {});
});

test('armour, AC, weapon masteries and class attack features', async (t) => {
  const base = rules.create(fighter); // STR 17, DEX 14, CON 14
  const ac = (patch, level = 1) => rules.derive({ ...base, weapons: [], ...patch }, level);
  assert.equal(ac({}).armorClass, 12);
  assert.equal(ac({ armor: 'Chain Mail' }).armorClass, 16);
  assert.equal(ac({ armor: 'Chain Mail', shield: true }).armorClass, 18);
  assert.equal(ac({ armor: 'Chain Mail', shield: true, feats: ['Defense'] }).armorClass, 19, 'Defense: +1 in armour');
  assert.equal(ac({ armor: 'Breastplate' }).armorClass, 16, 'medium armour caps DEX at +2');
  assert.equal(ac({ armor: 'Studded Leather Armor' }).armorClass, 14);
  assert.deepEqual(ac({ armor: 'Plate Armor', abilities: { ...base.abilities, str: 13 } }).armor.speedPenalty, 10);
  assert.equal(ac({ armor: 'Plate Armor', abilities: { ...base.abilities, str: 13 } }).speed, 20);
  assert.equal(ac({ className: 'Barbarian' }).armorClass, 14, 'Unarmored Defense: 10 + DEX + CON');
  assert.equal(ac({ className: 'Barbarian', shield: true }).armorClass, 16);
  assert.equal(ac({ className: 'Monk', abilities: { ...base.abilities, wis: 16 } }).armorClass, 15, '10 + DEX + WIS');
  assert.equal(ac({ className: 'Monk', shield: true, abilities: { ...base.abilities, wis: 16 } }).armorClass, 14, 'a shield ends Unarmored Defense for Monks');
  assert.match(ac({ className: 'Wizard', armor: 'Plate Armor' }).armor.notes[0], /Not trained with heavy armour/);
  assert.match(ac({ armor: 'Plate Armor' }).armor.notes.join(' '), /Stealth/);

  const atk = (patch, level = 1) => Object.fromEntries(ac(patch, level).attacks.map((a) => [a.name, a]));
  const monk = atk({ className: 'Monk', abilities: { ...base.abilities, dex: 18 }, weapons: [{ id: 'a', weapon: 'Shortsword' }, { id: 'b', weapon: 'Longsword' }, { id: 'c', weapon: 'Spear' }] }, 5);
  assert.deepEqual([monk['Unarmed Strike'].damage, monk['Unarmed Strike'].ability], ['1d8+4', 'dex'], 'Martial Arts d8 at level 5');
  assert.deepEqual([monk.Shortsword.damage, monk.Shortsword.ability], ['1d8+4', 'dex']);
  assert.equal(monk.Spear.damage, '1d8+4', 'simple melee weapons are Monk weapons');
  assert.deepEqual([monk.Longsword.damage, monk.Longsword.ability, monk.Longsword.proficient], ['1d8+3', 'str', false]);
  assert.equal(ac({ className: 'Monk' }, 5).speed, 40, 'Unarmored Movement');
  assert.equal(ac({ className: 'Rogue' }, 5).sneakAttack, '3d6');
  const barb = atk({ className: 'Barbarian', raging: true, weapons: [{ id: 'a', weapon: 'Greataxe' }, { id: 'b', weapon: 'Longbow' }] });
  assert.equal(barb.Greataxe.damage, '1d12+5', 'STR +3 and Rage +2');
  assert.equal(barb.Longbow.damage, '1d8+2', 'no rage bonus on DEX ranged attacks');
  const archer = atk({ feats: ['Archery'], weapons: [{ id: 'a', weapon: 'Longbow' }, { id: 'b', weapon: 'Longsword', bonus: 1 }] });
  assert.equal(archer.Longbow.toHit, 6, 'DEX +2, proficiency +2, Archery +2');
  assert.deepEqual([archer['Longsword +1'].toHit, archer['Longsword +1'].damage], [6, '1d8+4']);
  const mastered = atk({ masteries: ['Longsword'], weapons: [{ id: 'a', weapon: 'Longsword' }] });
  assert.equal(mastered.Longsword.mastery.name, 'Sap');
  assert.match(mastered.Longsword.mastery.description, /Disadvantage/);

  const { call, ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const make = (b) => call('POST', `/api/campaigns/${camp.id}/characters`, b, gm);
  assert.equal((await make({ ...fighter, name: 'Short', species: 'Human', speciesSkills: ['Stealth'], size: 'Small' })).body.character.size, 'Small');
  assert.equal((await make({ ...fighter, name: 'X', size: 'Small' })).status, 400, 'Dwarves are Medium');
  const c = (await make({ ...fighter, name: 'Brann' })).body.character;
  const patch = (b) => call('PATCH', `/api/characters/${c.id}`, b, gm);
  assert.equal((await patch({ armor: 'Shield' })).status, 400);
  assert.equal((await patch({ armor: 'Chain Mail', shield: true })).body.sheet.armorClass, 18);
  assert.equal((await patch({ masteries: ['Longsword', 'Greatsword', 'Longbow', 'Dagger'] })).status, 400, 'Fighter 1 masters 3');
  assert.deepEqual((await patch({ masteries: ['Longsword', 'Greatsword', 'Longbow'] })).body.sheet.masteries, { allowed: 3, chosen: ['Longsword', 'Greatsword', 'Longbow'] });
  assert.equal((await patch({ raging: true })).status, 400, 'only Barbarians rage');
  assert.equal((await patch({ weapons: [{ weapon: 'Longsword', bonus: 4 }] })).status, 400);
  assert.equal((await patch({ weapons: [{ custom: { name: 'Bone Club', damage: '1d6', type: 'bludgeoning', category: 'simple melee', properties: ['Laser'] } }] })).status, 400);
  const custom = await patch({ weapons: [{ custom: { name: 'Bone Club', damage: '1d6', type: 'bludgeoning', category: 'simple melee', properties: ['Light', 'Thrown (20/60)'] }, bonus: 1 }] });
  const club = custom.body.sheet.attacks.find((a) => a.name === 'Bone Club');
  assert.deepEqual([club.toHit, club.damage], [6, '1d6+4']);
});

test('SRD spell catalogue: scaling, healing, prepared limits, Magic Initiate', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'milestone' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  assert.equal((await ok('GET', '/api/ruleset/spells', null, gm)).length, 339);
  const make = async (b) => (await ok('POST', `/api/campaigns/${camp.id}/characters`, b, gm)).character;
  const wiz = await make({ name: 'Ilse', species: 'Gnome', className: 'Wizard', background: 'Sage', abilityMethod: 'standard',
    baseScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 }, backgroundBonus: { int: 2, con: 1 }, classSkills: ['Investigation', 'Medicine'] }); // INT 17
  const patch = (c, b) => call('PATCH', `/api/characters/${c.id}`, b, gm);
  const cast = (c, b) => call('POST', `/api/characters/${c.id}/cast`, b, gm);
  const level = async (c, n) => { for (let i = 0; i < n; i++) await ok('POST', `/api/campaigns/${camp.id}/milestone`, { reason: 'up', characterIds: [c.id] }, gm); };

  assert.equal((await patch(wiz, { spells: [{ srd: 'Lightsaber' }] })).status, 400);
  // Wizard 1: 3 cantrips (+2 from Magic Initiate via Sage = 5), 4 prepared (+1 = 5).
  const six = ['Fire Bolt', 'Light', 'Mage Hand', 'Prestidigitation', 'Minor Illusion', 'Ray of Frost'].map((n) => ({ srd: n }));
  assert.match((await patch(wiz, { spells: six })).body.error, /knows 5 cantrip/);
  const many = ['Magic Missile', 'Shield', 'Sleep', 'Burning Hands', 'Thunderwave', 'Detect Magic'].map((n) => ({ srd: n }));
  assert.match((await patch(wiz, { spells: many })).body.error, /prepare 5 spell/);
  const sheet = (await patch(wiz, { spells: [{ srd: 'Fire Bolt' }, { srd: 'Burning Hands' }, { srd: 'Fireball', prepared: false }, ...many.slice(0, 4)] })).body;
  assert.deepEqual([sheet.sheet.spellcasting.cantripsMax, sheet.sheet.spellcasting.preparedMax], [5, 5]);
  const id = (n) => sheet.character.spells.find((x) => x.srd === n).id;
  assert.equal((await cast(wiz, { spellId: id('Fireball') })).status, 409, 'unprepared');
  assert.deepEqual(sheet.spells.find((x) => x.name === 'Burning Hands').at, { 1: { damage: '3d6' } });

  await level(wiz, 4); // level 5: Fire Bolt 2d10, level 3 slots
  await ok('PATCH', `/api/characters/${wiz.id}`, { spells: [{ srd: 'Fire Bolt' }, { srd: 'Burning Hands' }, { srd: 'Fireball' }] }, gm);
  const s5 = await ok('GET', `/api/characters/${wiz.id}`, null, gm);
  const fid = (n) => s5.character.spells.find((x) => x.srd === n).id;
  const bolt = (await cast(wiz, { spellId: fid('Fire Bolt') })).body.rolls;
  assert.deepEqual(bolt.map((r) => r.formula), ['1d20+6', '2d10'], 'INT +3, proficiency +3; cantrip upgrade at 5');
  const fb = (await cast(wiz, { spellId: fid('Fireball'), slotLevel: 3 })).body.rolls;
  assert.deepEqual([fb[0].formula, fb[0].label], ['8d6', 'Ilse casts Fireball: damage (fire), DC 14 DEX save']);
  assert.equal((await cast(wiz, { spellId: fid('Burning Hands'), slotLevel: 2 })).body.rolls[0].formula, '4d6');
  assert.deepEqual(s5.spells.find((x) => x.name === 'Fireball').at, { 3: { damage: '8d6' } });

  // Healing with the casting modifier, upcast.
  const cleric = await make({ name: 'Ada', species: 'Human', className: 'Cleric', background: 'Acolyte', abilityMethod: 'standard',
    baseScores: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 }, backgroundBonus: { wis: 2, cha: 1 }, classSkills: ['History', 'Medicine'], speciesSkills: ['Perception'] }); // WIS 17
  await level(cleric, 2);
  const cs = (await patch(cleric, { spells: [{ srd: 'Cure Wounds' }] })).body;
  assert.equal((await cast(cleric, { spellId: cs.character.spells[0].id, slotLevel: 2 })).body.rolls[0].formula, '4d8+3');

  // Magic Initiate gives a Fighter (Sage) two cantrips and one free level 1 casting per long rest.
  const ftr = await make({ ...fighter, name: 'Brann', background: 'Sage', backgroundBonus: { con: 2, int: 1 }, classSkills: ['Perception', 'Survival'] });
  const fs = (await patch(ftr, { spells: [{ srd: 'Fire Bolt' }, { srd: 'Light' }, { srd: 'Magic Missile' }] })).body;
  assert.deepEqual([fs.sheet.spellcasting.ability, fs.sheet.spellcasting.cantripsMax, fs.sheet.spellcasting.preparedMax], ['int', 2, 1]);
  const mm = fs.character.spells.find((x) => x.srd === 'Magic Missile').id;
  assert.equal((await cast(ftr, { spellId: mm })).status, 409, 'no slots');
  await ok('POST', `/api/characters/${ftr.id}/cast`, { spellId: mm, free: true }, gm);
  assert.equal((await cast(ftr, { spellId: mm, free: true })).status, 409, 'once per long rest');
  await ok('POST', `/api/characters/${ftr.id}/rest`, { kind: 'long' }, gm);
  await ok('POST', `/api/characters/${ftr.id}/cast`, { spellId: mm, free: true }, gm);
  const soldier = await make({ ...fighter, name: 'Plain' }); // Soldier: no Magic Initiate
  assert.equal((await patch(soldier, { spells: [{ srd: 'Light' }] })).status, 409);
});

test('death saves, hit dice, journal, initiative into the tracker, aligned party levels', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const pat = (await ok('POST', '/api/users', { name: 'Pat' })).token;
  const ana = (await ok('POST', '/api/users', { name: 'Ana' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'milestone' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  for (const tok of [pat, ana]) await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, tok);
  const brann = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { ...fighter, name: 'Brann' }, pat)).character; // 13 HP, d10, CON +2
  const hp = (b, tok = pat) => call('POST', `/api/characters/${brann.id}/hp`, b, tok);

  // Hit Point Dice on a short rest.
  await hp({ damage: 8 });
  const rest = (await call('POST', `/api/characters/${brann.id}/rest`, { kind: 'short', hitDice: 1 }, pat)).body;
  assert.equal(rest.rolls[0].formula, '1d10+2');
  assert.equal(rest.character.hp.current, Math.min(13, 5 + rest.rolls[0].total));
  assert.equal(rest.character.hitDiceUsed, 1);
  assert.equal((await call('POST', `/api/characters/${brann.id}/rest`, { kind: 'short', hitDice: 1 }, pat)).status, 400, 'level 1: one die');
  assert.equal((await ok('POST', `/api/characters/${brann.id}/rest`, { kind: 'long' }, pat)).character.hitDiceUsed, 0);

  // Dropping to 0 HP, failing by damage, recovering by healing.
  assert.equal((await call('POST', `/api/characters/${brann.id}/death-save`, null, pat)).status, 409, 'not dying');
  let s = (await hp({ damage: 13 })).body.character;
  assert.deepEqual([s.hp.current, s.conditions.includes('Unconscious')], [0, true]);
  s = (await hp({ damage: 1 })).body.character;
  assert.equal(s.deathSaves.failures, 1);
  s = (await hp({ damage: 1, critical: true })).body.character;
  assert.equal(s.deathSaves.failures, 3);
  assert.equal(s.deathSaves.dead, true);
  assert.equal((await hp({ heal: 5 })).status, 409, 'dead');
  // A second character: heal from 0 clears saves; then roll until stable, dead or back up.
  const ilse = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { ...fighter, name: 'Ilse' }, ana)).character;
  const hp2 = (b) => call('POST', `/api/characters/${ilse.id}/hp`, b, ana);
  await hp2({ damage: 13 }); await hp2({ damage: 1 });
  s = (await hp2({ heal: 2 })).body.character;
  assert.deepEqual([s.hp.current, s.deathSaves, s.conditions.includes('Unconscious')], [2, { successes: 0, failures: 0 }, false]);
  assert.equal((await hp2({ damage: 30 })).body.character.deathSaves.dead, true, 'massive damage: 28 over 0 ≥ max HP 13');
  const third = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { ...fighter, name: 'Third' }, ana)).character;
  await call('POST', `/api/characters/${third.id}/hp`, { damage: 13 }, ana);
  let last;
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', `/api/characters/${third.id}/death-save`, null, ana);
    if (r.status === 409) break;
    last = r.body;
    const ds = last.character.deathSaves;
    assert.equal(last.rolls[0].formula, '1d20');
    if (ds.stable || ds.dead || last.character.hp.current === 1) break;
  }
  const ds = last.character.deathSaves;
  assert.ok(ds.stable ? ds.successes === 3 : ds.dead ? ds.failures === 3 : last.character.hp.current === 1, JSON.stringify(ds));

  // Journal: private entries stay with owner and GM; party entries are shared.
  await ok('POST', `/api/characters/${ilse.id}/journal`, { text: 'I took the ring.', visibility: 'private' }, ana);
  const j = await ok('POST', `/api/characters/${ilse.id}/journal`, { text: 'We camped by the river.', visibility: 'party' }, ana);
  assert.equal(j.character.journal.length, 2);
  assert.deepEqual((await ok('GET', `/api/characters/${ilse.id}`, null, pat)).journal.map((e) => e.text), ['We camped by the river.']);
  assert.equal((await ok('GET', `/api/characters/${ilse.id}`, null, gm)).character.journal.length, 2);
  assert.equal((await call('DELETE', `/api/journal-entries/${j.character.journal[0].id}`, null, pat)).status, 403);
  assert.equal((await ok('DELETE', `/api/journal-entries/${j.character.journal[0].id}`, null, ana)).character.journal.length, 1);

  // Initiative into the encounter tracker.
  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'T', x: 1, y: 1 }, gm);
  const scene = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'S', visibility: 'party' }, gm);
  const fresh = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { ...fighter, name: 'Runa' }, pat)).character;
  const tokA = await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'x', x: 1, y: 1, characterId: fresh.id }, gm);
  const gob = await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Goblin', x: 2, y: 2, visibility: 'gm' }, gm);
  const initiative = (b, tok) => call('POST', `/api/scenes/${scene.id}/encounter/initiative`, b, tok);
  assert.equal((await initiative({ tokenId: tokA.id }, pat)).status, 409, 'no encounter yet');
  await ok('PUT', `/api/scenes/${scene.id}/encounter`, { combatants: [{ tokenId: tokA.id, initiative: 0 }, { tokenId: gob.id, initiative: 0 }] }, gm);
  const ir = (await initiative({ tokenId: tokA.id }, pat)).body;
  assert.equal(ir.formula, '1d20+2', 'DEX +2 from the sheet');
  assert.equal((await initiative({ tokenId: gob.id }, pat)).status, 403);
  const gr = (await initiative({ tokenId: gob.id, bonus: 2 }, gm)).body;
  assert.equal(gr.visibility, 'gm', "a hidden monster's roll stays hidden");
  const enc = (await ok('GET', `/api/scenes/${scene.id}`, null, gm)).encounter;
  assert.deepEqual(enc.combatants.map((x) => x.initiative), [ir.total, gr.total].sort((a, b) => b - a));
  assert.ok(!(await ok('GET', `/api/worlds/${world.id}/rolls`, null, pat)).some((r) => r.id === gr.id));

  // Aligned party levels: whole-party awards only, newcomers join at the party's level.
  const aligned = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Aligned', alignLevels: true }, gm);
  const join = async (tok) => ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${aligned.id}/invites`, {}, gm)).code}/accept`, {}, tok);
  await join(pat); await join(ana);
  const a1 = (await ok('POST', `/api/campaigns/${aligned.id}/characters`, { ...fighter, name: 'A1' }, pat)).character;
  await ok('POST', `/api/campaigns/${aligned.id}/milestone`, { reason: 'Chapter 1' }, gm);
  assert.equal((await call('POST', `/api/campaigns/${aligned.id}/milestone`, { reason: 'x', characterIds: [a1.id] }, gm)).status, 409);
  const a2 = await ok('POST', `/api/campaigns/${aligned.id}/characters`, { ...fighter, name: 'A2' }, ana);
  assert.equal(a2.level, 2);
  assert.equal(a2.character.hp.current, a2.sheet.maxHp);
  assert.match(a2.history[0].reason, /party's level/);
});

test('level-up choices, class features and starting equipment', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'milestone' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const make = (b) => call('POST', `/api/campaigns/${camp.id}/characters`, b, gm);

  // Starting equipment packages.
  assert.equal((await make({ ...fighter, name: 'X', classEquipment: 5 })).status, 400);
  const eqA = (await make({ ...fighter, name: 'Kit', classEquipment: 0, backgroundEquipment: 1 })).body;
  assert.deepEqual([eqA.character.armor, eqA.sheet.armorClass], ['Chain Mail', 16]);
  assert.deepEqual(eqA.character.weapons.map((w) => w.weapon), ['Greatsword', 'Flail', 'Javelin']);
  assert.equal(eqA.character.inventory.find((i) => i.name === 'Javelin').qty, 8);
  assert.equal(eqA.character.currency.gp, 4 + 50, 'option A gold + Soldier option B (50 GP)');
  assert.equal((await make({ ...fighter, name: 'Gold', classEquipment: 2 })).body.character.currency.gp, 155);

  const created = (await make({ ...fighter, name: 'Brann' })).body; // STR 17, CON 14
  const c = created.character;
  assert.deepEqual(created.pendingChoices, [{ level: 1, kind: 'fightingStyle' }]);
  assert.ok(created.features.some((f) => f.name === 'Second Wind' && f.description.length > 50));
  const choose = (b) => call('POST', `/api/characters/${c.id}/choices`, b, gm);
  const up = async (n) => { for (let i = 0; i < n; i++) await ok('POST', `/api/campaigns/${camp.id}/milestone`, { reason: 'up', characterIds: [c.id] }, gm); };
  assert.equal((await choose({ level: 1, kind: 'fightingStyle', feat: 'Grappler' })).status, 400);
  let s = (await choose({ level: 1, kind: 'fightingStyle', feat: 'Archery' })).body;
  assert.deepEqual([s.pendingChoices, s.character.feats], [[], ['Savage Attacker', 'Archery']]);
  assert.equal((await choose({ level: 1, kind: 'fightingStyle', feat: 'Defense' })).status, 400, 'already chosen');

  await up(2);
  assert.equal((await choose({ level: 3, kind: 'subclass', subclass: 'Battle Master' })).status, 400, 'not in the SRD');
  s = (await choose({ level: 3, kind: 'subclass', subclass: 'Champion' })).body;
  assert.ok(s.features.some((f) => f.name === 'Improved Critical' && f.subclass === 'Champion'));

  await up(1); // level 4
  assert.equal((await choose({ level: 4, kind: 'feat', feat: 'Ability Score Improvement', increases: { str: 3 } })).status, 400);
  assert.equal((await choose({ level: 4, kind: 'feat', feat: 'Boon of Fate', increases: { str: 1 } })).status, 400, 'boons wait for 19');
  const hpBefore = (await ok('GET', `/api/characters/${c.id}`, null, gm)).sheet.maxHp;
  s = (await choose({ level: 4, kind: 'feat', feat: 'Ability Score Improvement', increases: { str: 1, con: 1 } })).body;
  assert.deepEqual([s.character.abilities.str, s.character.abilities.con], [18, 15]);
  assert.equal(s.sheet.maxHp, hpBefore, 'CON 15 keeps +2');
  await up(2); // level 6: Fighters get an extra feat
  assert.equal((await choose({ level: 6, kind: 'feat', feat: 'Skilled', skills: ['Athletics', 'Arcana', 'Stealth'] })).status, 400, 'Athletics already proficient');
  s = (await choose({ level: 6, kind: 'feat', feat: 'Magic Initiate', list: 'Wizard' })).body;
  assert.equal(s.sheet.spellcasting.ability, 'int');
  await up(1); // level 7: Champion's Additional Fighting Style
  assert.deepEqual((await ok('GET', `/api/characters/${c.id}`, null, gm)).pendingChoices, [{ level: 7, kind: 'fightingStyle' }]);
  s = (await choose({ level: 7, kind: 'fightingStyle', feat: 'Defense' })).body;
  await up(1); // level 8
  s = (await choose({ level: 8, kind: 'feat', feat: 'Ability Score Improvement', increases: { str: 2 } })).body;
  assert.equal(s.character.abilities.str, 20);
  await up(4); // level 12
  assert.equal((await choose({ level: 12, kind: 'feat', feat: 'Ability Score Improvement', increases: { str: 2 } })).status, 400, 'max 20');
  await choose({ level: 12, kind: 'feat', feat: 'Skilled', skills: ['Arcana', 'Stealth', 'History'] });
  await up(7); // level 19
  const pending = (await ok('GET', `/api/characters/${c.id}`, null, gm)).pendingChoices.map((x) => `${x.level}:${x.kind}`);
  assert.deepEqual(pending, ['14:feat', '16:feat', '19:boon']);
  s = (await choose({ level: 19, kind: 'boon', feat: 'Boon of Combat Prowess', increases: { str: 1 } })).body;
  assert.equal(s.character.abilities.str, 21, 'epic boons go to 30');
  assert.deepEqual(s.character.choices.map((x) => x.kind), ['fightingStyle', 'subclass', 'feat', 'feat', 'fightingStyle', 'feat', 'feat', 'boon']);
});
