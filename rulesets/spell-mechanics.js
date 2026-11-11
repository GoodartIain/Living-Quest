// Turns SRD spell text into the few mechanics the sheet can automate, and computes damage/healing formulas.
// Only fixed SRD phrasings are recognised; anything else stays description-only (never guessed).
'use strict';

const ABILITY = { Strength: 'str', Dexterity: 'dex', Constitution: 'con', Intelligence: 'int', Wisdom: 'wis', Charisma: 'cha' };

// s: a spell record from the 5e-database 2024 data.
function extractSpell(s) {
  const text = `${s.description} ${s.higher_level || ''}`.replace(/\s+/g, ' ');
  const save = text.match(/(?:makes?|must succeed on) an? (Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/);
  const out = { attack: s.attack_type ? 'attack' : save ? 'save' : 'none', saveAbility: !s.attack_type && save ? ABILITY[save[1]] : null,
    damage: null, heal: null, cantripDice: null, perSlot: null };
  const base = s.damage && s.damage.damage_at_slot_level && s.damage.damage_at_slot_level[s.level];
  if (base) {
    out.damage = { dice: base, type: s.damage.damage_type.name, addMod: text.includes(`${base} plus your spellcasting ability modifier`) };
  }
  const heal = text.match(/regains? (?:a number of )?Hit Points equal to (\d+d\d+) plus your spellcasting ability modifier/);
  if (heal) out.heal = { dice: heal[1], addMod: true };
  const tiers = text.match(/levels 5 \((\d+d\d+)\), 11 \((\d+d\d+)\), and 17 \((\d+d\d+)\)/);
  if (s.level === 0 && tiers && out.damage) out.cantripDice = [tiers[1], tiers[2], tiers[3]];
  const up = text.match(/(damage|healing)(?: \(both initial and later\))? increases by (\d+d\d+) for (?:each|every) (?:spell )?slot level above (\d)/);
  if (up && Number(up[3]) === s.level && ((up[1] === 'damage' && out.damage) || (up[1] === 'healing' && out.heal))) out.perSlot = { of: up[1] === 'damage' ? 'damage' : 'heal', dice: up[2] };
  return out;
}

// Adds dice of the same size together ("8d6" + "2d6" = "10d6"); otherwise appends.
function addDice(a, b) {
  const [x, y] = [a.match(/^(\d+)d(\d+)$/), b.match(/^(\d+)d(\d+)$/)];
  return x && y && x[2] === y[2] ? `${Number(x[1]) + Number(y[1])}d${x[2]}` : `${a}+${b}`;
}
const times = (dice, n) => { const m = dice.match(/^(\d+)d(\d+)$/); return `${Number(m[1]) * n}d${m[2]}`; };
const withMod = (f, mod) => (mod ? `${f}${mod > 0 ? '+' : '-'}${Math.abs(mod)}` : f);

// spell: extracted fields + level; returns { damage?, heal? } formulas for this cast.
function spellFormulas(spell, { slotLevel = spell.level, characterLevel = 1, mod = 0 } = {}) {
  const out = {};
  const extra = Math.max(0, slotLevel - spell.level);
  if (spell.damage) {
    let dice = spell.damage.dice;
    if (spell.cantripDice && characterLevel >= 5) dice = spell.cantripDice[characterLevel >= 17 ? 2 : characterLevel >= 11 ? 1 : 0];
    if (spell.perSlot && spell.perSlot.of === 'damage' && extra) dice = addDice(dice, times(spell.perSlot.dice, extra));
    out.damage = spell.damage.addMod ? withMod(dice, mod) : dice;
  }
  if (spell.heal) {
    let dice = spell.heal.dice;
    if (spell.perSlot && spell.perSlot.of === 'heal' && extra) dice = addDice(dice, times(spell.perSlot.dice, extra));
    out.heal = withMod(dice, mod);
  }
  return out;
}

module.exports = { extractSpell, spellFormulas, addDice };
