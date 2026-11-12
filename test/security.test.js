// Milestone 13 security review: an authorization sweep over every API route. A world full of data (every kind of
// object, each holding a secret marker) is attacked by an outsider (signed in, not a member) on every route, and by a
// spectator on every write route. Nothing may succeed, nothing secret may come back, and stored data must not change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

// Routes anyone signed in (or anyone at all) may use by design: their own account, sign-in, creating their own world,
// global rules data, and accepting an invite (the code is the credential; checked separately below).
const OPEN = new Set(['GET /api/me', 'POST /api/worlds', 'GET /api/ruleset', 'GET /api/ruleset/spells', 'GET /api/auth/config', 'POST /api/users', 'POST /api/auth/register', 'POST /api/auth/login',
  'POST /api/auth/logout', 'POST /api/auth/logout-everywhere', 'POST /api/stream-tickets', 'GET /api/account', 'PATCH /api/account', 'GET /api/account/export', 'DELETE /api/account',
  'POST /api/invites/:id/accept']);

test('security: every route refuses outsiders and spectators where it should, and leaks nothing', async (t) => {
  const { app, call, ok, close } = await boot();
  t.after(close);
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const pat = await user('Pat');
  const out = await user('Outsider');
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, pat);
  const viv = await user('Viv');
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role: 'spectator' }, gm)).code}/accept`, {}, viv);
  const invite = await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm);
  const loc = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'SECRET-place', x: 1, y: 1, visibility: 'gm' }, gm);
  const page = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'SECRET-page', kind: 'npc', visibility: 'gm', body: 'SECRET-body' }, gm);
  const page2 = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'Other', kind: 'npc', visibility: 'gm' }, gm);
  const rel = await ok('POST', `/api/worlds/${world.id}/relationships`, { fromId: page.id, toId: page2.id, kind: 'SECRET-rel' }, gm);
  const scene = await ok('POST', `/api/locations/${loc.id}/scenes`, { name: 'SECRET-scene', visibility: 'gm' }, gm);
  const tok = await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'SECRET-token', x: 0, y: 0, visibility: 'gm' }, gm);
  const ch = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', backstory: 'SECRET-backstory', personality: 'SECRET-personality', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat)).character;
  const journal = await ok('POST', `/api/characters/${ch.id}/journal`, { text: 'SECRET-journal' }, pat);
  const brew = await ok('POST', `/api/worlds/${world.id}/homebrew`, { kind: 'species', name: 'Stonefolk', data: { size: 'Medium', speed: 30 } }, gm);
  const gmId = app.db.worlds[0].ownerId;
  const msg = await ok('POST', `/api/campaigns/${camp.id}/chat`, { channel: 'whisper', toUserIds: [gmId], text: 'SECRET-chat' }, pat);
  const quest = await ok('POST', `/api/campaigns/${camp.id}/quests`, { title: 'SECRET-quest', visibility: 'gm' }, gm);
  const adv = await ok('POST', `/api/worlds/${world.id}/adventures`, { title: 'SECRET-adv', nodes: { start: { text: 'SECRET-node', choices: [{ label: 'go', to: 'end' }] }, end: { text: 'done' } } }, gm);
  const dt = await ok('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 5, activities: ['training', { key: 'adv', name: 'Adv', days: 1, adventureId: adv.id }] }, gm);
  const action = await ok('POST', `/api/downtime/${dt.id}/actions`, { characterId: ch.id, activity: 'adv', startDay: dt.startDay, details: 'SECRET-plan' }, pat);
  const run = app.db.questRuns[0];
  const npc = await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'SECRET-npc', visibility: 'gm' }, gm);
  const trig = await ok('POST', `/api/scenes/${scene.id}/triggers`, { name: 'SECRET-trigger', text: 'SECRET-trigtext' }, gm);
  const fac = await ok('POST', `/api/worlds/${world.id}/factions`, { name: 'SECRET-faction', visibility: 'gm' }, gm);
  const hap = await ok('POST', `/api/campaigns/${camp.id}/happenings`, { inDays: 3, label: 'SECRET-happening', effects: [{ kind: 'influence', factionId: fac.id, delta: 1 }] }, gm);
  await ok('PATCH', `/api/campaigns/${camp.id}/director`, { notes: 'SECRET-notes' }, gm);
  const ids = { worlds: world.id, campaigns: camp.id, invites: invite.code, locations: loc.id, pages: page.id, relationships: rel.id, scenes: scene.id, tokens: tok.id,
    characters: ch.id, 'journal-entries': journal.journal ? journal.journal[0].id : app.db.characters[0].journal[0].id, homebrew: brew.id, messages: msg.id, downtime: dt.id,
    'downtime-actions': action.id, 'quest-runs': run.id, adventures: adv.id, quests: quest.id, npcs: npc.id, triggers: trig.id, factions: fac.id, happenings: hap.id,
    maps: loc.mapId, ruleset: 'x' };
  // A generous body, so routes get past simple validation to their permission checks.
  const body = { name: 'x', title: 'x', text: 'hello', kind: 'npc', visibility: 'public', x: 1, y: 1, amount: 5, reason: 'x', category: 'quest', role: 'player',
    characterId: ch.id, sceneId: scene.id, locationId: loc.id, campaignId: camp.id, enabled: true, status: 'approved', days: 1, advanceDays: 1, index: 0, option: 0,
    channel: 'table', check: 'skill:Stealth', formula: '1d20', damage: 1, heal: 1, notes: 'x', liveSceneId: scene.id, effects: [{ kind: 'influence', factionId: fac.id, delta: 1 }],
    question: 'q', options: ['a', 'b'], emoji: '🔥', duration: 1, activities: ['training'], activity: 'training', startDay: dt.startDay, decisions: {}, hash: 'x', fromId: page.id, toId: page2.id,
    question2: null, data: { size: 'Medium', speed: 30 }, onStream: true, delta: 1, at: '12:00', inDays: 1, label: 'x', combatants: [], walls: [], reveal: true, x0: 0, y0: 0, x1: 1, y1: 1 };
  const snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(app.db).filter(([k]) => k !== 'events' && k !== 'sessions' && k !== 'users')));

  const attack = async (who, label, filter) => {
    const problems = [];
    for (const key of app.routes) {
      const [method, pattern] = key.split(' ');
      if (OPEN.has(key) || !filter(method)) continue;
      const kind = pattern.split('/')[2];
      if (pattern.includes(':id') && !(kind in ids)) { problems.push(`${key}: no test id for ${kind}`); continue; }
      const url = pattern.replace(':id', ids[kind]);
      const before = snapshot();
      const r = await call(method, url, method === 'GET' ? null : body, who);
      const leaked = (JSON.stringify(r.body).match(/SECRET-?[a-z]+/g) || []);
      if (r.status === 200 && !(label === 'spectator' && method === 'GET')) problems.push(`${key}: ${label} got 200`);
      if (leaked.length) problems.push(`${key}: ${label} saw ${[...new Set(leaked)].join(', ')}`);
      if (snapshot() !== before) problems.push(`${key}: ${label} changed stored data`);
    }
    return problems;
  };
  assert.deepEqual(await attack(out, 'outsider', () => true), []);
  // Spectators may read (filtered, checked by the leak tests) but never change anything.
  assert.deepEqual(await attack(viv, 'spectator', (m) => m !== 'GET'), []);
  // Spectators' reads: nothing secret either.
  const spectatorReads = await attack(viv, 'spectator', (m) => m === 'GET');
  assert.deepEqual(spectatorReads.filter((p) => p.includes(' saw ')), []);
  // Invites: a wrong code does nothing.
  assert.equal((await call('POST', '/api/invites/not-a-code/accept', {}, out)).status, 404);
  assert.ok(app.db.memberships.every((m) => m.userId !== app.db.users.find((u) => u.name === 'Outsider').id));
  // Unauthenticated: every non-open route is 401.
  for (const key of app.routes.filter((k) => !OPEN.has(k))) {
    const [method, pattern] = key.split(' ');
    const r = await call(method, pattern.replace(':id', ids[pattern.split('/')[2]] || 'x'), method === 'GET' ? null : {});
    assert.equal(r.status, 401, key);
  }
});
