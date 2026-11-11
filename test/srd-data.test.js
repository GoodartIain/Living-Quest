// The generated SRD data and the spell-text extractor: spot checks against known SRD 5.2.1 values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../rulesets/srd-5.2.1.data.json');
const { spellFormulas, addDice, extractSpell } = require('../rulesets/spell-mechanics.js');

const spell = (n) => data.spells.find((s) => s.name === n) || assert.fail(`missing ${n}`);

test('spell mechanics extracted from SRD text', () => {
  assert.equal(data.spells.length, 339);
  const f = (n, o) => spellFormulas(spell(n), o);
  assert.deepEqual([spell('Fire Bolt').attack, f('Fire Bolt'), f('Fire Bolt', { characterLevel: 5 }), f('Fire Bolt', { characterLevel: 17 })],
    ['attack', { damage: '1d10' }, { damage: '2d10' }, { damage: '4d10' }]);
  assert.deepEqual([spell('Fireball').saveAbility, f('Fireball'), f('Fireball', { slotLevel: 5 })], ['dex', { damage: '8d6' }, { damage: '10d6' }]);
  assert.deepEqual(f('Cure Wounds', { slotLevel: 3, mod: 3 }), { heal: '6d8+3' }, 'upcast rule found inside the description');
  assert.deepEqual(f('Mass Healing Word', { slotLevel: 5, mod: -1 }), { heal: '4d4-1' });
  assert.deepEqual([spell('Sacred Flame').saveAbility, f('Sacred Flame', { characterLevel: 11 })], ['dex', { damage: '3d8' }]);
  assert.deepEqual([spell('Hold Person').saveAbility, f('Hold Person')], ['wis', {}]);
  assert.deepEqual([spell('Bless').attack, spell('Magic Missile').damage], ['none', null], 'nothing guessed');
  assert.equal(spell('Eldritch Blast').cantripDice, null, 'beams, not bigger dice');
  assert.deepEqual(data.armor['Half-Plate Armor'], { category: 'medium', base: 15, dexMax: 2, strength: 0, stealthDisadvantage: true });
  assert.deepEqual(data.armor['Plate Armor'], { category: 'heavy', base: 18, dexMax: 0, strength: 15, stealthDisadvantage: true });
  assert.deepEqual(data.armor['Studded Leather Armor'].dexMax, null, 'light armour: full DEX');
  assert.equal(data.mastery.Longsword, 'Sap');
  assert.deepEqual(data.classes.Wizard.levels.map((l) => l.prepared).slice(0, 5), [4, 5, 6, 7, 9]);
  assert.equal(data.classes.Monk.levels[4].classSpecific.martial_arts_die, 8);
  assert.equal(data.classes.Fighter.subclass.name, 'Champion');
  assert.equal(data.classes.Fighter.startingEquipment[0].options[2].gp, 155);
});

test('extractor edge cases', () => {
  assert.equal(addDice('8d6', '2d6'), '10d6');
  assert.equal(addDice('1d8', '1d6'), '1d8+1d6');
  const e = extractSpell({ level: 2, description: 'Each creature has Advantage on Wisdom saving throws.', damage: null });
  assert.deepEqual([e.attack, e.saveAbility], ['none', null], 'a buff that mentions saves is not a save spell');
});
