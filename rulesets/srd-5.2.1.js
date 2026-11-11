// Ruleset adapter: fifth-edition rules from the System Reference Document 5.2.1.
//
// This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC,
// available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0
// International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.
//
// An adapter exports: id, options (what a creation wizard may offer), create(input) → validated character fields
// (throws { status: 400 }), derive(character, level) → computed sheet numbers, xpLevel(xp), MAX_LEVEL.
'use strict';

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const SKILLS = {
  Acrobatics: 'dex', 'Animal Handling': 'wis', Arcana: 'int', Athletics: 'str', Deception: 'cha', History: 'int',
  Insight: 'wis', Intimidation: 'cha', Investigation: 'int', Medicine: 'wis', Nature: 'int', Perception: 'wis',
  Performance: 'cha', Persuasion: 'cha', Religion: 'int', 'Sleight of Hand': 'dex', Stealth: 'dex', Survival: 'wis',
};
const ALL = Object.keys(SKILLS);

const SPECIES = {
  Dragonborn: { size: 'Medium', speed: 30, traits: ['Draconic Ancestry', 'Breath Weapon', 'Damage Resistance', 'Darkvision', 'Draconic Flight'] },
  Dwarf: { size: 'Medium', speed: 30, hpPerLevel: 1, traits: ['Darkvision', 'Dwarven Resilience', 'Dwarven Toughness', 'Stonecunning'] },
  Elf: { size: 'Medium', speed: 30, skills: { count: 1, from: ['Insight', 'Perception', 'Survival'] }, traits: ['Darkvision', 'Elven Lineage', 'Fey Ancestry', 'Keen Senses', 'Trance'] },
  Gnome: { size: 'Small', speed: 30, traits: ['Darkvision', 'Gnomish Cunning', 'Gnomish Lineage'] },
  Goliath: { size: 'Medium', speed: 35, traits: ['Giant Ancestry', 'Large Form', 'Powerful Build'] },
  Halfling: { size: 'Small', speed: 30, traits: ['Brave', 'Halfling Nimbleness', 'Luck', 'Naturally Stealthy'] },
  Human: { size: 'Medium or Small', speed: 30, skills: { count: 1, from: ALL }, traits: ['Resourceful', 'Skillful', 'Versatile'] },
  Orc: { size: 'Medium', speed: 30, traits: ['Adrenaline Rush', 'Darkvision', 'Relentless Endurance'] },
  Tiefling: { size: 'Medium or Small', speed: 30, traits: ['Darkvision', 'Fiendish Legacy', 'Otherworldly Presence'] },
};

const CLASSES = {
  Barbarian: { hitDie: 12, saves: ['str', 'con'], skills: { count: 2, from: ['Animal Handling', 'Athletics', 'Intimidation', 'Nature', 'Perception', 'Survival'] } },
  Bard: { hitDie: 8, saves: ['dex', 'cha'], skills: { count: 3, from: ALL } },
  Cleric: { hitDie: 8, saves: ['wis', 'cha'], skills: { count: 2, from: ['History', 'Insight', 'Medicine', 'Persuasion', 'Religion'] } },
  Druid: { hitDie: 8, saves: ['int', 'wis'], skills: { count: 2, from: ['Arcana', 'Animal Handling', 'Insight', 'Medicine', 'Nature', 'Perception', 'Religion', 'Survival'] } },
  Fighter: { hitDie: 10, saves: ['str', 'con'], skills: { count: 2, from: ['Acrobatics', 'Animal Handling', 'Athletics', 'History', 'Insight', 'Intimidation', 'Perception', 'Persuasion', 'Survival'] } },
  Monk: { hitDie: 8, saves: ['str', 'dex'], skills: { count: 2, from: ['Acrobatics', 'Athletics', 'History', 'Insight', 'Religion', 'Stealth'] } },
  Paladin: { hitDie: 10, saves: ['wis', 'cha'], skills: { count: 2, from: ['Athletics', 'Insight', 'Intimidation', 'Medicine', 'Persuasion', 'Religion'] } },
  Ranger: { hitDie: 10, saves: ['str', 'dex'], skills: { count: 3, from: ['Animal Handling', 'Athletics', 'Insight', 'Investigation', 'Nature', 'Perception', 'Stealth', 'Survival'] } },
  Rogue: { hitDie: 8, saves: ['dex', 'int'], skills: { count: 4, from: ['Acrobatics', 'Athletics', 'Deception', 'Insight', 'Intimidation', 'Investigation', 'Perception', 'Persuasion', 'Sleight of Hand', 'Stealth'] } },
  Sorcerer: { hitDie: 6, saves: ['con', 'cha'], skills: { count: 2, from: ['Arcana', 'Deception', 'Insight', 'Intimidation', 'Persuasion', 'Religion'] } },
  Warlock: { hitDie: 8, saves: ['wis', 'cha'], skills: { count: 2, from: ['Arcana', 'Deception', 'History', 'Intimidation', 'Investigation', 'Nature', 'Religion'] } },
  Wizard: { hitDie: 6, saves: ['int', 'wis'], skills: { count: 2, from: ['Arcana', 'History', 'Insight', 'Investigation', 'Medicine', 'Nature', 'Religion'] } },
};

const BACKGROUNDS = {
  Acolyte: { abilities: ['int', 'wis', 'cha'], skills: ['Insight', 'Religion'], feat: 'Magic Initiate (Cleric)', tool: "Calligrapher's Supplies" },
  Criminal: { abilities: ['dex', 'con', 'int'], skills: ['Sleight of Hand', 'Stealth'], feat: 'Alert', tool: "Thieves' Tools" },
  Sage: { abilities: ['con', 'int', 'wis'], skills: ['Arcana', 'History'], feat: 'Magic Initiate (Wizard)', tool: "Calligrapher's Supplies" },
  Soldier: { abilities: ['str', 'dex', 'con'], skills: ['Athletics', 'Intimidation'], feat: 'Savage Attacker', tool: 'Gaming Set (one of your choice)' },
};

const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
const POINT_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
const POINTS = 27;
const XP = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];
const MAX_LEVEL = 20;
const CONDITIONS = ['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible',
  'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious'];

const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const mod = (score) => Math.floor((score - 10) / 2);
const proficiency = (level) => 2 + Math.floor((level - 1) / 4);
const xpLevel = (xp) => XP.filter((t) => xp >= t).length;

function pickSkills(chosen, rule, taken, label) {
  if (!rule) return [];
  if (!Array.isArray(chosen) || chosen.length !== rule.count) bad(`${label}: choose exactly ${rule.count} skill(s)`);
  for (const s of chosen) {
    if (!rule.from.includes(s)) bad(`${label}: ${s} is not an option`);
    if (taken.has(s)) bad(`${label}: ${s} is already proficient, choose another`);
    taken.add(s);
  }
  return chosen;
}

// input: { species, className, background, abilityMethod, baseScores {str..cha}, backgroundBonus {ability: 1|2}, classSkills [], speciesSkills [] }
function create(input) {
  const species = SPECIES[input.species] || bad('unknown species');
  const cls = CLASSES[input.className] || bad('unknown class');
  const bg = BACKGROUNDS[input.background] || bad('unknown background');

  const base = input.baseScores || {};
  const values = ABILITIES.map((a) => base[a]);
  if (!values.every(Number.isInteger)) bad('baseScores needs an integer for each of ' + ABILITIES.join(', '));
  if (input.abilityMethod === 'standard') {
    if ([...values].sort((a, b) => b - a).join() !== STANDARD_ARRAY.join()) bad(`standard array must use ${STANDARD_ARRAY.join(', ')} once each`);
  } else if (input.abilityMethod === 'pointbuy') {
    if (values.some((v) => POINT_COST[v] === undefined)) bad('point buy scores must be 8..15');
    const spent = values.reduce((n, v) => n + POINT_COST[v], 0);
    if (spent > POINTS) bad(`point buy spends ${spent} of ${POINTS} points`);
  } else bad('abilityMethod must be standard or pointbuy');

  // Background: +2 and +1 to two of its abilities, or +1 to all three.
  const bonus = input.backgroundBonus || {};
  const keys = Object.keys(bonus);
  if (keys.some((k) => !bg.abilities.includes(k))) bad(`${input.background} can only raise ${bg.abilities.join(', ')}`);
  const shape = keys.map((k) => bonus[k]).sort().join();
  if (!(shape === '1,2' && keys.length === 2) && !(shape === '1,1,1' && keys.length === 3)) bad('background bonus must be +2/+1 to two abilities or +1 to all three');
  const abilities = Object.fromEntries(ABILITIES.map((a) => [a, base[a] + (bonus[a] || 0)]));
  if (Object.values(abilities).some((v) => v > 20)) bad('no ability score may exceed 20');

  const taken = new Set(bg.skills);
  const classSkills = pickSkills(input.classSkills, cls.skills, taken, input.className);
  const speciesSkills = pickSkills(input.speciesSkills ?? [], species.skills, taken, input.species);

  return {
    species: input.species, className: input.className, background: input.background,
    abilityMethod: input.abilityMethod, baseScores: Object.fromEntries(ABILITIES.map((a) => [a, base[a]])), backgroundBonus: bonus,
    abilities, skills: [...bg.skills, ...classSkills, ...speciesSkills],
    feats: [bg.feat], tools: [bg.tool],
  };
}

function maxHp(c, level) {
  const die = CLASSES[c.className].hitDie;
  const con = mod(c.abilities.con);
  const extra = SPECIES[c.species].hpPerLevel || 0;
  // Level 1: full hit die; later levels take the fixed average (die/2 + 1). Each level adds at least 1.
  let hp = Math.max(1, die + con) + extra;
  for (let l = 2; l <= level; l++) hp += Math.max(1, die / 2 + 1 + con) + extra;
  return hp;
}

function derive(c, level) {
  const pb = proficiency(level);
  const cls = CLASSES[c.className];
  const species = SPECIES[c.species];
  const mods = Object.fromEntries(ABILITIES.map((a) => [a, mod(c.abilities[a])]));
  const skills = Object.fromEntries(ALL.map((s) => [s, mods[SKILLS[s]] + (c.skills.includes(s) ? pb : 0)]));
  return {
    proficiencyBonus: pb,
    modifiers: mods,
    saves: Object.fromEntries(ABILITIES.map((a) => [a, mods[a] + (cls.saves.includes(a) ? pb : 0)])),
    savingThrowProficiencies: cls.saves,
    skills,
    passivePerception: 10 + skills.Perception,
    initiative: mods.dex + (c.feats.includes('Alert') ? pb : 0),
    armorClass: 10 + mods.dex, // unarmored; armour is not modelled yet
    speed: species.speed,
    size: species.size,
    hitDie: `d${cls.hitDie}`,
    maxHp: maxHp(c, level),
    traits: species.traits,
  };
}

const options = {
  abilities: ABILITIES, skills: SKILLS, conditions: CONDITIONS, standardArray: STANDARD_ARRAY, pointCost: POINT_COST, points: POINTS, xpThresholds: XP,
  species: SPECIES, classes: CLASSES, backgrounds: BACKGROUNDS,
  attribution: 'Includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, licensed under CC-BY-4.0.',
};

module.exports = { id: 'srd-5.2.1', options, create, derive, xpLevel, proficiency, MAX_LEVEL, CONDITIONS, SKILLS, ABILITIES };
