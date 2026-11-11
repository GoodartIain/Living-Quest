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
