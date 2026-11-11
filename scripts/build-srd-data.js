#!/usr/bin/env node
// Builds rulesets/srd-5.2.1.data.json from a checkout of https://github.com/5e-bits/5e-database (MIT licence;
// its 2024 data is SRD 5.2.1 content, CC-BY-4.0). Run when updating the data:
//   git clone --depth 1 https://github.com/5e-bits/5e-database /tmp/5e-database
//   node scripts/build-srd-data.js /tmp/5e-database
// Only the 2024 data that carries 2024 rules is used; class skills, weapon/armour proficiencies, species and
// backgrounds stay hand-maintained in rulesets/srd-5.2.1.js because the dataset still has 2014 values there.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { extractSpell } = require('../rulesets/spell-mechanics.js');

const root = process.argv[2] || fail('usage: node scripts/build-srd-data.js <path to 5e-database checkout>');
function fail(m) { console.error(m); process.exit(1); }
const load = (name) => JSON.parse(fs.readFileSync(path.join(root, 'src/2024/en', `5e-SRD-${name}.json`), 'utf8'));

const spells = load('Spells').map((s) => ({
  name: s.name, level: s.level, school: s.school.name, classes: s.classes.map((c) => c.name),
  castingTime: s.casting_time, ritual: !!s.ritual, range: s.range, components: s.components.join(', '), material: s.material || '',
  duration: s.duration, concentration: !!s.concentration, description: s.description, higherLevel: s.higher_level || '',
  ...extractSpell(s),
})).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));

const equipment = load('Equipment');
const cat = (e) => e.equipment_categories.map((c) => c.index);
const armor = Object.fromEntries(equipment.filter((e) => e.armor_class).map((e) => {
  const c = cat(e);
  const category = c.includes('shields') ? 'shield' : c.includes('light-armor') ? 'light' : c.includes('medium-armor') ? 'medium' : 'heavy';
  return [e.name, { category, base: e.armor_class.base, dexMax: e.armor_class.dex_bonus ? (e.armor_class.max_bonus ?? null) : 0,
    strength: e.str_minimum || 0, stealthDisadvantage: !!e.stealth_disadvantage }];
}));
const mastery = Object.fromEntries(equipment.filter((e) => e.mastery).map((e) => [e.name, e.mastery.name]));
const masteries = Object.fromEntries(load('Weapon-Mastery-Properties').map((m) => [m.name, m.description]));

const optionSet = (o) => ({
  text: o.desc,
  options: o.from.options.map((opt) => {
    const items = opt.option_type === 'multiple' ? opt.items : [opt];
    return {
      items: items.filter((i) => i.option_type === 'counted_reference').map((i) => ({ name: i.of.name + (i.of.note ? ` (${i.of.note})` : ''), count: i.count })),
      gp: items.filter((i) => i.option_type === 'money').reduce((n, i) => n + i.count, 0),
    };
  }),
});

const levels = load('Levels');
const features = load('Features');
const subclasses = load('Subclasses');
const classes = {};
for (const c of load('Classes')) {
  const rows = levels.filter((l) => l.class.index === c.index && !l.subclass).sort((a, b) => a.level - b.level);
  const sub = subclasses.find((s) => s.class.index === c.index);
  const featureOf = (f) => ({ level: Number(f.level.name.split(' ').pop()), name: f.name, description: f.description });
  classes[c.name] = {
    levels: rows.map((r) => ({
      level: r.level,
      features: r.features.map((f) => f.name),
      cantrips: r.spellcasting ? r.spellcasting.cantrips_known || 0 : 0,
      prepared: r.spellcasting ? r.spellcasting.prepared_spells || 0 : 0,
      ...(r.class_specific && { classSpecific: r.class_specific }),
    })),
    features: features.filter((f) => f.class && f.class.index === c.index && !f.subclass).map(featureOf).sort((a, b) => a.level - b.level),
    subclass: sub && {
      name: sub.name, summary: sub.summary || '', description: sub.description || '',
      features: features.filter((f) => f.subclass && f.subclass.index === sub.index).map(featureOf).sort((a, b) => a.level - b.level),
    },
    startingEquipment: (c.starting_equipment_options || []).map(optionSet),
    multiclassing: {
      prerequisites: (c.multi_classing.prerequisites || []).map((p) => ({ ability: p.ability_score.index, minimum: p.minimum_score })),
      prerequisiteOptions: c.multi_classing.prerequisite_options
        ? c.multi_classing.prerequisite_options.from.options.map((o) => ({ ability: o.ability_score.index, minimum: o.minimum_score })) : [],
    },
  };
}
const backgrounds = Object.fromEntries(load('Backgrounds').map((b) => [b.name, { startingEquipment: (b.equipment_options || []).map(optionSet) }]));
const feats = load('Feats').map((f) => ({ name: f.name, type: f.type, minLevel: (f.prerequisites && f.prerequisites.minimum_level) || 0,
  needsFeature: (f.prerequisites && f.prerequisites.feature_named) || null, description: f.description }));
const conditions = Object.fromEntries(load('Conditions').map((c) => [c.name, c.description]));

const data = {
  attribution: 'Includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, licensed under CC-BY-4.0. Converted from the 5e-database project (MIT licence, (c) 2018-2020 Adrian Padua, Christopher Ward).',
  spells, armor, mastery, masteries, classes, backgrounds, feats, conditions,
};
const out = path.join(__dirname, '..', 'rulesets', 'srd-5.2.1.data.json');
fs.writeFileSync(out, JSON.stringify(data, null, 1) + '\n');
console.log(`wrote ${out}: ${spells.length} spells (${spells.filter((s) => s.damage).length} with damage, ${spells.filter((s) => s.attack !== 'none').length} attack/save), ` +
  `${Object.keys(armor).length} armour, ${Object.keys(classes).length} classes, ${feats.length} feats`);
