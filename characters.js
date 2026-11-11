// Milestone 4: characters, advancement ledger (XP and milestones), and server-side dice.
// Level and XP are never stored on the character: they are derived from the append-only `advancements` ledger,
// which is also the level history.
'use strict';
const dice = require('./dice.js');
const rules = require('./rulesets/srd-5.2.1.js');

const XP_CATEGORIES = ['combat', 'quest', 'exploration', 'roleplay', 'downtime', 'other'];
const COINS = ['cp', 'sp', 'ep', 'gp', 'pp'];

module.exports = function characters({ db, find, fail, need, record, id, check, publishScene, canSeeScene }) {
  const { str, oneOf, num, safeUrl, bool } = check;
  const optional = (v, name, max) => (v === undefined ? '' : typeof v === 'string' && v.length <= max ? v : fail(400, `${name} must be text up to ${max} chars`));

  const ledger = (c) => db.advancements.filter((a) => a.characterId === c.id);
  const levelOf = (c) => Math.min(rules.MAX_LEVEL, 1 + ledger(c).filter((a) => a.kind === 'level').length);
  const xpOf = (c) => ledger(c).filter((a) => a.kind === 'xp').reduce((n, a) => n + a.amount, 0);
  const pendingOf = (c) => Math.max(0, Math.min(rules.MAX_LEVEL, rules.xpLevel(xpOf(c))) - levelOf(c));
  const maxHpOf = (c) => rules.derive(c, levelOf(c)).maxHp;
  const campaignOf = (c) => find('campaigns', c.campaignId);
  const levelUpRule = (camp) => camp.advancement.levelUp || 'confirm';

  function access(u, c) {
    const role = need(u, c.worldId, 'spectator');
    if (role === 'gm' || c.ownerId === u.id) return 'full';
    if (db.memberships.some((m) => m.userId === u.id && m.campaignId === c.campaignId)) return 'summary';
    fail(404, 'character not found');
  }
  const owner = (u, c) => { if (access(u, c) !== 'full') fail(403, 'only the owner or GM may change this character'); };

  function summary(c) {
    return { id: c.id, name: c.name, portraitUrl: c.portraitUrl, species: c.species, className: c.className,
      level: levelOf(c), conditions: c.conditions, ownerName: find('users', c.ownerId).name, campaignId: c.campaignId };
  }
  function sheet(c) {
    const level = levelOf(c);
    const xp = xpOf(c);
    const camp = campaignOf(c);
    return {
      character: c, level, xp,
      nextLevelXp: level < rules.MAX_LEVEL ? rules.options.xpThresholds[level] : null,
      pendingLevels: camp.advancement.mode === 'xp' ? pendingOf(c) : 0,
      advancement: { ...camp.advancement, levelUp: levelUpRule(camp) },
      sheet: rules.derive(c, level),
      history: ledger(c).map((a) => ({ ...a, by: find('users', a.by).name })),
    };
  }
  function view(u, c) { return access(u, c) === 'full' ? { access: 'full', ...sheet(c) } : { access: 'summary', ...summary(c) }; }

  // Tokens linked to a character show its name and conditions; HP only to the GM and the token's controllers.
  function tokenInfo(characterId, privileged) {
    const c = db.characters.find((x) => x.id === characterId);
    if (!c) return null;
    const info = { name: c.name, conditions: c.conditions, level: levelOf(c) };
    if (privileged) info.hp = { ...c.hp, max: maxHpOf(c) };
    return info;
  }
  function sync(c) {
    for (const sceneId of new Set(db.tokens.filter((t) => t.characterId === c.id).map((t) => t.sceneId))) publishScene(sceneId);
  }

  function addLevel(c, by, reason, auto) {
    const before = maxHpOf(c);
    db.advancements.push({ id: id(), worldId: c.worldId, campaignId: c.campaignId, characterId: c.id, kind: 'level', amount: 1,
      category: null, reason, by, auto, at: new Date().toISOString() });
    c.hp.current += maxHpOf(c) - before; // levelling raises current HP by the same amount as the maximum
  }
  function targets(camp, ids) {
    const all = db.characters.filter((c) => c.campaignId === camp.id);
    if (ids === undefined) return all; // whole party
    if (!Array.isArray(ids) || !ids.length) fail(400, 'characterIds must be a non-empty list, or left out for the whole party');
    return ids.map((cid) => all.find((c) => c.id === cid) || fail(400, 'character is not in this campaign'));
  }

  // Every bonus comes from the sheet, so a player cannot inflate a roll by editing the request.
  function checkFormula(c, chk, { versatile = false, crit = false } = {}) {
    const s = rules.derive(c, levelOf(c));
    const [kind, what] = String(chk).split(':');
    const d20 = (bonus, label) => ({ formula: `1d20${bonus < 0 ? '-' : '+'}${Math.abs(bonus)}`, label: `${c.name}: ${label}` });
    if (kind === 'skill' && s.skills[what] !== undefined) return d20(s.skills[what], `${what} check`);
    if (kind === 'save' && rules.ABILITIES.includes(what)) return d20(s.saves[what], `${what.toUpperCase()} save`);
    if (kind === 'ability' && rules.ABILITIES.includes(what)) return d20(s.modifiers[what], `${what.toUpperCase()} check`);
    if (kind === 'initiative') return d20(s.initiative, 'Initiative');
    if (kind === 'sneak') return { formula: crit ? doubleDice(s.sneakAttack || fail(409, 'only Rogues have Sneak Attack')) : s.sneakAttack || fail(409, 'only Rogues have Sneak Attack'), label: `${c.name}: Sneak Attack${crit ? ' (critical)' : ''}` };
    if (kind === 'spellattack') return d20((s.spellcasting || fail(409, `${c.className}s do not cast spells`)).attackBonus, 'spell attack');
    const atk = (kind === 'attack' || kind === 'damage') && (s.attacks.find((a) => a.id === what) || fail(404, 'no such attack on this character'));
    if (kind === 'attack') return d20(atk.toHit, `${atk.name} attack${atk.proficient ? '' : ' (not proficient)'}`);
    if (kind === 'damage') {
      if (versatile && !atk.versatileDamage) fail(400, `${atk.name} is not versatile`);
      const f = versatile ? atk.versatileDamage : atk.damage;
      return { formula: crit ? doubleDice(f) : f, label: `${c.name}: ${atk.name} damage (${atk.type}${versatile ? ', two-handed' : ''}${crit ? ', critical' : ''})` };
    }
    fail(400, 'check must be skill:<Skill>, save:<ability>, ability:<ability>, initiative, spellattack, sneak, attack:<id> or damage:<id>');
  }
  // A critical hit rolls the damage dice twice; modifiers are added once.
  const doubleDice = (f) => f.replace(/(\d*)d(\d+)/g, (_, n, m) => `${2 * (Number(n) || 1)}d${m}`);

  function makeRoll(u, worldId, { formula, label = '', mode = 'normal', visibility = 'public', sceneId = null, characterId = null }) {
    if (sceneId != null) {
      const sc = find('scenes', sceneId);
      if (sc.worldId !== worldId || !canSeeScene(u, sc)) fail(404, 'scene not found');
    }
    const result = dice.roll(str(formula, 'formula', 100), mode);
    const r = { id: id(), worldId, sceneId: sceneId ?? null, userId: u.id, userName: u.name, characterId, label: label.slice(0, 120), visibility, ...result, at: new Date().toISOString() };
    db.rolls.push(r);
    if (r.sceneId) publishScene(r.sceneId);
    return r;
  }

  const PROPERTY = /^(Finesse|Light|Heavy|Reach|Two-Handed|Loading|Versatile \(\d*d\d+\)|Thrown \(\d+\/\d+\)|Ammunition \(\d+\/\d+\))$/;
  // SRD weapons by name, or a custom weapon the GM or player defines; either may be magic (+1 to +3).
  function validWeapons(list) {
    if (!Array.isArray(list) || list.length > 20) fail(400, 'weapons must be a list of up to 20');
    return list.map((w) => {
      const base = { id: typeof w.id === 'string' && w.id.length <= 40 && w.id !== 'unarmed' ? w.id : id(), bonus: num(w.bonus ?? 0, 'magic bonus', 0, 3, true) };
      if (w.custom) {
        const k = w.custom;
        const damage = str(k.damage, 'custom damage', 20);
        if (!/^(\d*d\d+|\d+)$/.test(damage)) fail(400, 'custom damage must look like 1d8 or 2d6');
        if (!Array.isArray(k.properties) || k.properties.some((x) => !PROPERTY.test(x))) fail(400, 'custom properties must be from: Finesse, Light, Heavy, Reach, Two-Handed, Loading, Versatile (1d10), Thrown (20/60), Ammunition (80/320)');
        return { ...base, custom: { name: str(k.name, 'custom weapon name', 60), damage, type: oneOf(k.type, ['bludgeoning', 'piercing', 'slashing', 'acid', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'poison', 'psychic', 'radiant', 'thunder'], 'damage type'),
          category: oneOf(k.category, ['simple melee', 'simple ranged', 'martial melee', 'martial ranged'], 'category'), properties: k.properties } };
      }
      return { ...base, weapon: rules.WEAPONS[w.weapon] ? w.weapon : fail(400, `unknown weapon ${w.weapon}; choose from the SRD weapon list or define a custom weapon`) };
    });
  }
  function validSpells(list) {
    if (!Array.isArray(list) || list.length > 300) fail(400, 'spells must be a list of up to 300');
    return list.map((sp) => {
      const attack = oneOf(sp.attack ?? 'none', ['none', 'attack', 'save'], 'spell attack');
      const damage = sp.damage ? str(sp.damage, 'spell damage', 60) : '';
      if (damage) dice.parse(damage); // reject formulas that could not be rolled later
      return { id: typeof sp.id === 'string' && sp.id.length <= 40 ? sp.id : id(), name: str(sp.name, 'spell name', 80),
        level: num(sp.level ?? 0, 'spell level', 0, 9, true), attack, saveAbility: attack === 'save' ? oneOf(sp.saveAbility, rules.ABILITIES, 'save ability') : null,
        damage, damageType: optional(sp.damageType, 'damage type', 30), prepared: sp.prepared !== false, notes: optional(sp.notes, 'spell notes', 2000) };
    });
  }

  // public: everyone in the world; private: the roller and the GM; gm: GM only (GM rolls behind the screen).
  const seesRoll = (u, role, r) => (r.visibility === 'public' ? role !== 'none' : role === 'gm' || (r.visibility === 'private' && r.userId === u.id));
  const rollsFor = (u, role, filter) => db.rolls.filter((r) => filter(r) && seesRoll(u, role, r)).slice(-30).reverse();

  const routes = {
    'GET /api/ruleset': () => rules.options,

    'POST /api/campaigns/:id/characters': (u, b, p) => {
      const camp = find('campaigns', p.id);
      const role = need(u, camp.worldId, 'player');
      const member = db.memberships.some((m) => m.userId === u.id && m.campaignId === camp.id && m.role === 'player');
      if (role !== 'gm' && !member) fail(403, 'join this campaign as a player first');
      let ownerId = u.id;
      if (b.ownerId !== undefined && b.ownerId !== u.id) {
        if (role !== 'gm') fail(403, 'only the GM may create characters for others');
        if (!db.memberships.some((m) => m.userId === b.ownerId && m.campaignId === camp.id && m.role === 'player')) fail(400, 'owner must be a player in this campaign');
        ownerId = b.ownerId;
      }
      const built = rules.create(b);
      const c = { id: id(), worldId: camp.worldId, campaignId: camp.id, ownerId, ruleset: rules.id,
        name: str(b.name, 'name', 80), portraitUrl: b.portraitUrl ? safeUrl(b.portraitUrl) : '',
        personality: optional(b.personality, 'personality', 4000), backstory: optional(b.backstory, 'backstory', 20000),
        ...built, hp: { current: 0, temp: 0 }, conditions: [], inventory: [], currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
        weapons: [], spells: [], slotsUsed: {}, armor: null, shield: false, masteries: [], raging: false,
        deathSaves: { successes: 0, failures: 0 }, hitDiceUsed: 0, journal: [] };
      c.hp.current = rules.derive(c, 1).maxHp;
      db.characters.push(c);
      record(u.id, 'character.created', { characterId: c.id, campaignId: camp.id, ownerId });
      return sheet(c);
    },

    'GET /api/campaigns/:id/characters': (u, _b, p) => {
      const camp = find('campaigns', p.id);
      const role = need(u, camp.worldId, 'spectator');
      if (role !== 'gm' && !db.memberships.some((m) => m.userId === u.id && m.campaignId === camp.id)) fail(404, 'campaign not found');
      return db.characters.filter((c) => c.campaignId === camp.id)
        .map((c) => ({ ...summary(c), mine: c.ownerId === u.id, pendingLevels: role === 'gm' && camp.advancement.mode === 'xp' ? pendingOf(c) : undefined }));
    },

    'GET /api/characters/:id': (u, _b, p) => view(u, find('characters', p.id)),

    'PATCH /api/characters/:id': (u, b, p) => {
      const c = find('characters', p.id);
      owner(u, c);
      const ch = {};
      if (b.name !== undefined) ch.name = str(b.name, 'name', 80);
      if (b.portraitUrl !== undefined) ch.portraitUrl = b.portraitUrl ? safeUrl(b.portraitUrl) : '';
      if (b.personality !== undefined) ch.personality = optional(b.personality, 'personality', 4000);
      if (b.backstory !== undefined) ch.backstory = optional(b.backstory, 'backstory', 20000);
      if (b.conditions !== undefined) {
        if (!Array.isArray(b.conditions) || b.conditions.some((x) => !rules.CONDITIONS.includes(x))) fail(400, `conditions must be from: ${rules.CONDITIONS.join(', ')}`);
        ch.conditions = [...new Set(b.conditions)];
      }
      if (b.inventory !== undefined) {
        if (!Array.isArray(b.inventory) || b.inventory.length > 200) fail(400, 'inventory must be a list of up to 200 items');
        ch.inventory = b.inventory.map((it) => ({ id: typeof it.id === 'string' && it.id.length <= 40 ? it.id : id(),
          name: str(it.name, 'item name', 80), qty: num(it.qty ?? 1, 'quantity', 0, 9999, true), notes: optional(it.notes, 'item notes', 500) }));
      }
      if (b.weapons !== undefined) ch.weapons = validWeapons(b.weapons);
      if (b.armor !== undefined) ch.armor = b.armor === null ? null : b.armor !== 'Shield' && rules.DATA.armor[b.armor] ? b.armor : fail(400, `armor must be null or one of: ${Object.keys(rules.DATA.armor).filter((x) => x !== 'Shield').join(', ')}`);
      if (b.shield !== undefined) ch.shield = bool(b.shield, 'shield');
      if (b.raging !== undefined) {
        if (c.className !== 'Barbarian') fail(400, 'only Barbarians rage');
        ch.raging = bool(b.raging, 'raging');
      }
      if (b.masteries !== undefined) {
        const allowed = rules.masteryCount(c, levelOf(c));
        if (!Array.isArray(b.masteries) || b.masteries.length > allowed) fail(400, `${c.className} level ${levelOf(c)} may master ${allowed} weapon kind(s)`);
        for (const m of b.masteries) if (!rules.weaponProficient(c, m)) fail(400, `${m}: choose SRD weapons ${c.name} is proficient with`);
        ch.masteries = [...new Set(b.masteries)];
      }
      if (b.spells !== undefined) ch.spells = validSpells(b.spells);
      if (b.currency !== undefined) ch.currency = Object.fromEntries(COINS.map((k) => [k, num(b.currency[k] ?? 0, k, 0, 1e9, true)]));
      if (!Object.keys(ch).length) fail(400, 'nothing to change');
      Object.assign(c, ch);
      record(u.id, 'character.updated', { characterId: c.id, fields: Object.keys(ch) });
      sync(c);
      return sheet(c);
    },

    // { damage } | { heal } | { temp }. Damage drains temporary HP first; temporary HP do not stack (keep the higher).
    'POST /api/characters/:id/hp': (u, b, p) => {
      const c = find('characters', p.id);
      owner(u, c);
      const max = maxHpOf(c);
      const keys = ['damage', 'heal', 'temp'].filter((k) => b[k] !== undefined);
      if (keys.length !== 1) fail(400, 'send exactly one of damage, heal, temp');
      const n = num(b[keys[0]], keys[0], 0, 10000, true);
      const before = { ...c.hp };
      if (keys[0] === 'damage') {
        const fromTemp = Math.min(c.hp.temp, n);
        c.hp = { temp: c.hp.temp - fromTemp, current: Math.max(0, c.hp.current - (n - fromTemp)) };
      } else if (keys[0] === 'heal') c.hp = { ...c.hp, current: Math.min(max, c.hp.current + n) };
      else c.hp = { ...c.hp, temp: Math.max(c.hp.temp, n) };
      record(u.id, 'character.hp', { characterId: c.id, [keys[0]]: n, before, after: c.hp });
      sync(c);
      return sheet(c);
    },

    'POST /api/campaigns/:id/xp': (u, b, p) => {
      const camp = find('campaigns', p.id);
      need(u, camp.worldId, 'gm');
      if (camp.advancement.mode !== 'xp') fail(409, 'this campaign uses milestone advancement; award a milestone instead');
      const amount = num(b.amount, 'amount', 1, 1000000, true);
      const category = oneOf(b.category ?? 'other', XP_CATEGORIES, 'category');
      const reason = str(b.reason, 'reason', 200);
      const list = targets(camp, b.characterIds);
      const at = new Date().toISOString();
      for (const c of list) {
        db.advancements.push({ id: id(), worldId: c.worldId, campaignId: camp.id, characterId: c.id, kind: 'xp', amount, category, reason, by: u.id, auto: false, at });
        if (levelUpRule(camp) === 'auto') while (pendingOf(c) > 0) addLevel(c, u.id, `Reached ${xpOf(c)} XP`, true);
        sync(c);
      }
      record(u.id, 'advancement.xp', { campaignId: camp.id, amount, category, reason, characterIds: list.map((c) => c.id) });
      return list.map((c) => ({ id: c.id, name: c.name, xp: xpOf(c), level: levelOf(c), pendingLevels: pendingOf(c) }));
    },

    'POST /api/campaigns/:id/milestone': (u, b, p) => {
      const camp = find('campaigns', p.id);
      need(u, camp.worldId, 'gm');
      if (camp.advancement.mode !== 'milestone') fail(409, 'this campaign uses XP; award XP instead');
      const reason = str(b.reason, 'reason', 200);
      const list = targets(camp, b.characterIds);
      const capped = list.filter((c) => levelOf(c) >= rules.MAX_LEVEL);
      if (capped.length) fail(409, `already at level ${rules.MAX_LEVEL}: ${capped.map((c) => c.name).join(', ')}`);
      for (const c of list) { addLevel(c, u.id, reason, false); sync(c); }
      record(u.id, 'advancement.milestone', { campaignId: camp.id, reason, characterIds: list.map((c) => c.id) });
      return list.map((c) => ({ id: c.id, name: c.name, level: levelOf(c) }));
    },

    // XP campaigns with confirmation: the GM approves one pending level at a time.
    'POST /api/characters/:id/level-up': (u, _b, p) => {
      const c = find('characters', p.id);
      need(u, c.worldId, 'gm');
      if (campaignOf(c).advancement.mode !== 'xp') fail(409, 'milestone campaigns level up through milestone awards');
      if (!pendingOf(c)) fail(409, `${c.name} has not reached the XP for level ${levelOf(c) + 1}`);
      addLevel(c, u.id, `Approved at ${xpOf(c)} XP`, false);
      record(u.id, 'advancement.level', { characterId: c.id, level: levelOf(c) });
      sync(c);
      return sheet(c);
    },

    'POST /api/worlds/:id/rolls': (u, b, p) => {
      const role = need(u, p.id, 'player');
      const visibility = oneOf(b.visibility ?? 'public', ['public', 'private', 'gm'], 'visibility');
      if (visibility === 'gm' && role !== 'gm') fail(403, 'only the GM can roll behind the screen');
      const mode = oneOf(b.mode ?? 'normal', ['normal', 'advantage', 'disadvantage'], 'mode');
      let formula = b.formula, label = typeof b.label === 'string' ? b.label.slice(0, 80) : '';
      let c = null;
      if (b.characterId != null) {
        c = find('characters', b.characterId);
        if (c.worldId !== p.id) fail(400, 'character belongs to another world');
        owner(u, c);
      }
      if (b.check !== undefined) {
        if (!c) fail(400, 'a check needs a characterId');
        ({ formula, label } = checkFormula(c, b.check, { versatile: b.versatile === true, crit: b.crit === true }));
      }
      return makeRoll(u, p.id, { formula, label, mode, visibility, sceneId: b.sceneId, characterId: c && c.id });
    },

    // Spends the slot, then rolls what the spell defines: a spell attack, damage, or damage against a save DC.
    'POST /api/characters/:id/cast': (u, b, p) => {
      const c = find('characters', p.id);
      owner(u, c);
      const role = need(u, c.worldId, 'player');
      const s = rules.derive(c, levelOf(c));
      const casting = s.spellcasting || fail(409, `${c.className}s do not cast spells`);
      const spell = c.spells.find((x) => x.id === b.spellId) || fail(404, 'spell not on this character');
      if (b.sceneId != null) { // checked before any slot is spent, so a refused cast changes nothing
        const sc = find('scenes', b.sceneId);
        if (sc.worldId !== c.worldId || !canSeeScene(u, sc)) fail(404, 'scene not found');
      }
      const visibility = oneOf(b.visibility ?? 'public', ['public', 'private', 'gm'], 'visibility');
      if (visibility === 'gm' && role !== 'gm') fail(403, 'only the GM can roll behind the screen');
      let slotLevel = 0;
      const used = { ...c.slotsUsed };
      if (spell.level > 0) {
        if (casting.pact) { // Pact Magic: every slot is the same level
          if (spell.level > casting.pact.level) fail(409, `pact slots are level ${casting.pact.level}`);
          if ((used.pact || 0) >= casting.pact.count) fail(409, 'no pact slots left; they return on a short rest');
          slotLevel = casting.pact.level;
          used.pact = (used.pact || 0) + 1;
        } else {
          slotLevel = num(b.slotLevel ?? spell.level, 'slotLevel', spell.level, 9, true);
          const max = casting.slots[slotLevel - 1] || 0;
          if ((used[slotLevel] || 0) >= max) fail(409, max ? `no level ${slotLevel} slots left` : `no level ${slotLevel} slots at this level`);
          used[slotLevel] = (used[slotLevel] || 0) + 1;
        }
      }
      c.slotsUsed = used;
      const at = slotLevel > spell.level ? ` at level ${slotLevel}` : '';
      const mode = oneOf(b.mode ?? 'normal', ['normal', 'advantage', 'disadvantage'], 'mode');
      const common = { visibility, sceneId: b.sceneId, characterId: c.id };
      const rolls = [];
      if (spell.attack === 'attack') rolls.push(makeRoll(u, c.worldId, { ...common, mode, formula: `1d20${casting.attackBonus < 0 ? '-' : '+'}${Math.abs(casting.attackBonus)}`, label: `${c.name} casts ${spell.name}${at}: spell attack` }));
      if (spell.damage) {
        const save = spell.attack === 'save' ? `, DC ${casting.saveDC} ${spell.saveAbility.toUpperCase()} save` : '';
        rolls.push(makeRoll(u, c.worldId, { ...common, formula: b.crit === true ? doubleDice(spell.damage) : spell.damage,
          label: `${c.name} casts ${spell.name}${at}: damage${spell.damageType ? ` (${spell.damageType})` : ''}${save}${b.crit === true ? ', critical' : ''}` }));
      }
      record(u.id, 'spell.cast', { characterId: c.id, spell: spell.name, spellLevel: spell.level, slotLevel });
      return { ...sheet(c), rolls };
    },

    // Long rest: full HP, no temp HP, all slots back. Short rest: Pact Magic slots back (hit dice are not modelled yet).
    'POST /api/characters/:id/rest': (u, b, p) => {
      const c = find('characters', p.id);
      owner(u, c);
      const kind = oneOf(b.kind, ['short', 'long'], 'kind');
      if (kind === 'long') { c.hp = { current: maxHpOf(c), temp: 0 }; c.slotsUsed = {}; }
      else { const { pact, ...rest } = c.slotsUsed; c.slotsUsed = rest; }
      record(u.id, `character.rest.${kind}`, { characterId: c.id });
      sync(c);
      return sheet(c);
    },

    'GET /api/worlds/:id/rolls': (u, _b, p) => {
      const role = need(u, p.id, 'spectator');
      return rollsFor(u, role, (r) => r.worldId === p.id);
    },
  };

  return { routes, tokenInfo, sceneRolls: (u, role, sceneId) => rollsFor(u, role, (r) => r.sceneId === sceneId), XP_CATEGORIES };
};
