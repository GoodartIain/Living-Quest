// Milestone 13: the mandatory end-to-end scenario, "Three Weeks in Greyhaven", step by step (numbers follow the brief).
// It passes only without conflicting records, hidden-information leakage, unauthorised advancement, missing updates or
// duplicate entities. Run with TEST_DATABASE_URL to include a restart at the end; with LIVEKIT_TEST_URL the voice tokens
// are also accepted by a real LiveKit server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, DB } = require('./helpers.js');
const { postgresStore } = require('../store.js');

const LK = process.env.LIVEKIT_TEST_URL;
const env = { LIVEKIT_URL: LK || 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' };

test('Three Weeks in Greyhaven', async (t) => {
  const app = await boot({ env });
  const { call, ok, listenTo } = app;
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return app.close(); });
  const db = app.app.db;

  // 1–3. A GM (a real account) creates a fantasy world with XP advancement and scheduled + reactive NPCs.
  const gm = (await ok('POST', '/api/auth/register', { name: 'Ada (GM)', email: 'ada@example.test', password: 'greyhaven gm password' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'The Vale', advancement: 'xp', npcAutonomy: 'reactive' }, gm);
  assert.deepEqual([world.settings.advancement, world.settings.npcAutonomy], ['xp', 'reactive']);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven' }, gm);

  // 4–6. A regional map with Greyhaven on it; Greyhaven has its own town map.
  const root = await ok('GET', `/api/locations/${world.rootLocationId}`, null, gm);
  await ok('PATCH', `/api/maps/${root.map.id}`, { imageUrl: 'https://maps.example.test/vale.png' }, gm);
  const greyhaven = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', type: 'town', x: 42, y: 37, visibility: 'public' }, gm);
  const townView = await ok('GET', `/api/locations/${greyhaven.id}`, null, gm);
  await ok('PATCH', `/api/maps/${townView.map.id}`, { imageUrl: 'https://maps.example.test/greyhaven.png' }, gm);
  assert.notEqual(townView.map.id, root.map.id, 'the town links to its own map');

  // 7. Tavern, blacksmith, market, dungeon entrance (and a hidden cave for later).
  const place = (name, type, x, y, extra = {}) => ok('POST', `/api/locations/${greyhaven.id}/children`, { name, type, x, y, visibility: 'public', ...extra }, gm);
  const tavern = await place('The Gilded Goose', 'tavern', 20, 30);
  const smithy = await place('Hilda\'s Forge', 'blacksmith', 40, 30);
  const market = await place('Market Square', 'market', 50, 50);
  const dungeon = await place('Dungeon Entrance', 'dungeon', 80, 70);
  const cave = await place('Smugglers\' Cave', 'cave', 90, 80, { requiresDiscovery: true });
  const mill = await place('Old Mill', 'mill', 10, 80);
  const road = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'South Road', type: 'road', x: 60, y: 90, visibility: 'public' }, gm);

  // 8. Wiki entries, NPCs and 2D/3D scenes linked to the places.
  await ok('PATCH', `/api/pages/${tavern.pageId}`, { body: 'Run by [[Mara]]. Hilda drinks here most evenings.' }, gm);
  const hildaPage = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'Hilda Ironhand', kind: 'npc', visibility: 'party', body: 'Blacksmith of [[Hilda\'s Forge]].' }, gm);
  const maraPage = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'Mara', kind: 'npc', visibility: 'party', body: 'Keeps [[The Gilded Goose]].' }, gm);
  const artefact = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'The Sunken Crown', kind: 'item', visibility: 'gm', body: 'An artefact lost beneath Greyhaven.', gmNotes: 'SECRET-crown' }, gm);
  await ok('POST', `/api/worlds/${world.id}/relationships`, { fromId: hildaPage.id, toId: smithy.pageId, kind: 'works at' }, gm);
  const tavernScene = await ok('POST', `/api/locations/${tavern.id}/scenes`, { name: 'Common room', visibility: 'public', cols: 16, rows: 12 }, gm);
  const dungeonScene = await ok('POST', `/api/locations/${dungeon.id}/scenes`, { name: 'Dungeon mouth', visibility: 'public', cols: 16, rows: 12 }, gm);
  await ok('PATCH', `/api/scenes/${dungeonScene.id}`, { walls: [{ x1: 0, y1: 6, x2: 6, y2: 6 }] }, gm);
  const npc = (b) => ok('POST', `/api/worlds/${world.id}/npcs`, b, gm);
  const hilda = await npc({ pageId: hildaPage.id, occupation: 'blacksmith', homeLocationId: greyhaven.id, visibility: 'party',
    schedule: [{ from: '06:00', locationId: smithy.id, activity: 'Working the forge' }, { from: '12:00', locationId: market.id, activity: 'Selling tools' },
      { from: '14:00', locationId: smithy.id, activity: 'Working the forge' }, { from: '19:00', locationId: tavern.id, activity: 'Drinking', sceneId: tavernScene.id, x: 3, y: 3 },
      { from: '22:00', locationId: greyhaven.id, activity: 'Sleeping' }],
    reactions: [{ on: 'smuggling', activity: 'Locking up the forge', locationId: 'stay', minutes: 60 }] });
  await npc({ pageId: maraPage.id, occupation: 'innkeeper', homeLocationId: tavern.id, visibility: 'party',
    schedule: [{ from: '07:00', locationId: tavern.id, activity: 'Serving', sceneId: tavernScene.id, x: 8, y: 2 }] });
  const jory = await npc({ name: 'Jory', occupation: 'travelling merchant', homeLocationId: road.id, visibility: 'party', autonomy: 'scheduled',
    schedule: [{ from: '00:00', locationId: road.id, activity: 'On the road' }] });

  // 9. Six players join; the GM creates their characters.
  const players = [];
  const heroes = [];
  const builds = [['Brann', 'Fighter', 'Soldier', ['Athletics', 'Perception']], ['Ilse', 'Wizard', 'Sage', ['Arcana', 'History']], ['Tam', 'Rogue', 'Criminal', ['Stealth', 'Acrobatics', 'Perception', 'Investigation']],
    ['Odo', 'Cleric', 'Acolyte', ['Medicine', 'Religion']], ['Wren', 'Ranger', 'Soldier', []], ['Kel', 'Bard', 'Acolyte', []]];
  for (const [i, [name, cls, bg]] of builds.entries()) {
    const tok = (await ok('POST', '/api/auth/register', { name: `Player ${i + 1}`, email: `p${i + 1}@example.test`, password: `player ${i + 1} password` })).token;
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, tok);
    players.push(tok);
    const uid = (await ok('GET', '/api/me', null, tok)).user.id;
    const opts = await ok('GET', `/api/worlds/${world.id}/ruleset`, null, gm);
    const cl = opts.classes[cls], b = opts.backgrounds[bg];
    const classSkills = cl.skills.from.filter((x) => !b.skills.includes(x)).slice(0, cl.skills.count);
    const made = await ok('POST', `/api/campaigns/${camp.id}/characters`, { ownerId: uid, name, species: 'Human', className: cls, background: bg, abilityMethod: 'standard',
      baseScores: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, backgroundBonus: { [b.abilities[0]]: 2, [b.abilities[1]]: 1 }, classSkills,
      speciesSkills: [Object.keys(opts.skills).find((x) => !b.skills.includes(x) && !classSkills.includes(x))] }, gm);
    assert.equal(made.character.ownerId, uid, `${name} belongs to their player`);
    heroes.push(made.character);
    await ok('PATCH', `/api/characters/${made.character.id}`, { currency: { gp: 30 } }, gm);
  }
  const [brann, ilse, tam, odo, wren, kel] = heroes;
  const [p1, p2, p3, p4, p5, p6] = players;
  assert.equal(db.characters.length, 6);

  // 10. A live session with voice and video: every player and the GM can join the call.
  for (const tok of [gm, ...players]) assert.equal((await ok('POST', `/api/campaigns/${camp.id}/voice/token`, {}, tok)).canPublish, true);
  if (LK) {
    const { identity } = await ok('POST', `/api/campaigns/${camp.id}/voice/token`, {}, gm);
    assert.ok(identity);
  }

  // 11. A spectator watches the GM-authorised broadcast.
  const viv = (await ok('POST', '/api/auth/register', { name: 'Viv (audience)', email: 'viv@example.test', password: 'spectator password' })).token;
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role: 'spectator' }, gm)).code}/accept`, {}, viv);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/voice/token`, {}, viv)).status, 403, 'spectators are not in the call');
  await ok('PATCH', `/api/campaigns/${camp.id}/director`, { notes: 'SECRET-notes: the mayor funds the smugglers', liveSceneId: dungeonScene.id }, gm);
  const cast = await ok('PATCH', `/api/campaigns/${camp.id}/broadcast`, { enabled: true, playlist: [dungeonScene.id, tavernScene.id], sceneId: dungeonScene.id, title: 'Three Weeks in Greyhaven', showParty: 'health' }, gm);
  const tv = await listenTo('/api/broadcast/stream', cast.key, 'key');
  const watch = await listenTo(`/api/campaigns/${camp.id}/chat/stream`, viv);
  streams.push(tv, watch);

  // 12. An encounter at the dungeon mouth; the party earns XP.
  const ids = Object.fromEntries((await ok('GET', `/api/worlds/${world.id}`, null, gm)).members.map((m) => [m.name, m.userId]));
  const tokens = [];
  for (const [i, h] of heroes.entries()) tokens.push(await ok('POST', `/api/scenes/${dungeonScene.id}/tokens`, { name: h.name, x: 2 + i, y: 8, characterId: h.id, visibility: 'public' }, gm));
  const goblin = await ok('POST', `/api/scenes/${dungeonScene.id}/tokens`, { name: 'SECRET-goblin-chief', x: 8, y: 2, visibility: 'gm' }, gm);
  await ok('PUT', `/api/scenes/${dungeonScene.id}/encounter`, { combatants: [...tokens.map((x, i) => ({ tokenId: x.id, initiative: 10 + i })), { tokenId: goblin.id, initiative: 12 }] }, gm);
  await ok('PATCH', `/api/tokens/${tokens[0].id}`, { x: 4, y: 7 }, p1);
  await ok('POST', `/api/worlds/${world.id}/rolls`, { characterId: brann.id, check: 'skill:Athletics', sceneId: dungeonScene.id }, p1);
  await ok('POST', `/api/characters/${brann.id}/hp`, { damage: 5 }, gm);
  await ok('POST', `/api/scenes/${dungeonScene.id}/encounter/next`, null, gm);
  await ok('DELETE', `/api/scenes/${dungeonScene.id}/encounter`, null, gm);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/xp`, { amount: 1000, reason: 'I deserve it', category: 'other' }, p3)).status, 403, 'no unauthorised advancement');
  await ok('POST', `/api/campaigns/${camp.id}/xp`, { amount: 300, reason: 'Goblins at the dungeon mouth', category: 'combat' }, gm);
  for (const h of heroes) assert.equal((await ok('GET', `/api/characters/${h.id}`, null, gm)).xp, 300);

  // Quests the downtime will touch; factions and a scheduled arrival for the world simulation.
  const crownQuest = await ok('POST', `/api/campaigns/${camp.id}/quests`, { title: 'The Sunken Crown', kind: 'main', objectives: [{ text: 'Learn what the crown is' }, { text: 'Find where it lies' }] }, gm);
  const ledgerQuest = await ok('POST', `/api/campaigns/${camp.id}/quests`, { title: 'Clear my name', kind: 'personal', characterId: tam.id, objectives: [{ text: 'Find the smuggler\'s ledger' }] }, gm);
  const smiths = await ok('POST', `/api/worlds/${world.id}/factions`, { name: 'Smiths\' Guild', visibility: 'party', leader: 'Hilda Ironhand', influence: 40, resources: 50, territory: [smithy.id], standings: { party: 0 } }, gm);
  const sail = await ok('POST', `/api/worlds/${world.id}/factions`, { name: 'Black Sail', visibility: 'gm', goals: 'SECRET-goals: take the mill', influence: 30, resources: 30, standings: { [smiths.id]: -10 },
    activities: [
      { name: 'Smuggling run', every: 5, cost: 10, significance: 'minor', effects: [{ kind: 'resources', delta: 25 }, { kind: 'event', eventKind: 'smuggling', locationId: greyhaven.id }] },
      { name: 'Seize the old mill', every: 21, significance: 'minor', effects: [{ kind: 'territory', locationId: mill.id }, { kind: 'rumour', text: 'Strangers have moved into the old mill.' }] },
    ] }, gm);
  await ok('POST', `/api/campaigns/${camp.id}/happenings`, { inDays: 9, label: 'Jory reaches Greyhaven', effects: [
    { kind: 'npc', npcId: jory.id, locationId: market.id, activity: 'Selling southern spices', minutes: 4 * 1440 },
    { kind: 'rumour', text: 'A merchant from the south has set up in the market.', locationId: market.id }] }, gm);

  // 13. Three weeks of downtime.
  const ledger = await ok('POST', `/api/worlds/${world.id}/adventures`, { title: 'The missing ledger', maxGp: 20, maxXp: 100, nodes: {
    start: { text: 'At dusk you reach the warehouse by the mill.', choices: [{ label: 'Sneak in', check: 'skill:Stealth', dc: 1, success: 'inside', failure: 'inside' }] },
    inside: { text: 'SECRET-node: the ledger names the mayor.', effects: [{ type: 'gp', amount: 15 }, { type: 'item', name: 'Smuggler\'s ledger', major: true },
      { type: 'quest', questId: ledgerQuest.id, objectiveId: ledgerQuest.objectives[0].id }, { type: 'discover', locationId: cave.id }, { type: 'journal', text: 'I found the ledger.' }] } } }, gm);
  const down = await ok('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 3, unit: 'weeks', activities: ['research', 'work',
    { key: 'ledger', name: 'Find the missing ledger', days: 3, adventureId: ledger.id },
    { key: 'guard', name: 'Train with the town guard', days: 10, resolution: 'manual' },
    { key: 'trade', name: 'Build a trading partnership with Hilda', days: 7, resolution: 'manual', gpCost: 10 }] }, gm);
  assert.equal(down.endDay - down.startDay, 21);
  const book = (tok, characterId, activity, day, extra = {}) => ok('POST', `/api/downtime/${down.id}/actions`, { characterId, activity, startDay: down.startDay + day, ...extra }, tok);
  // 14–17. Players act independently.
  const research = await book(p2, ilse.id, 'research', 0, { details: 'The Sunken Crown in the temple archive' });
  const sidequest = await book(p3, tam.id, 'ledger', 2);
  const guard = await book(p1, brann.id, 'guard', 0);
  const trade = await book(p6, kel.id, 'trade', 3);
  await book(p5, wren.id, 'work', 0);
  assert.equal((await call('POST', `/api/downtime/${down.id}/actions`, { characterId: brann.id, activity: 'work', startDay: down.startDay + 5 }, p1)).status, 409, 'no double-booked days');
  assert.equal((await call('POST', `/api/downtime/${down.id}/actions`, { characterId: odo.id, activity: 'work', startDay: down.startDay }, p1)).status, 403, 'only your own character');
  assert.equal((await call('PATCH', `/api/downtime-actions/${guard.id}`, { status: 'approved', outcome: { rewardXp: 9999 } }, p1)).status, 403, 'players cannot approve themselves');
  // Tam plays the side quest alone.
  const runId = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, p3)).windows[0].actions.find((a) => a.id === sidequest.id).runId;
  const played = await ok('POST', `/api/quest-runs/${runId}/choose`, { index: 0 }, p3);
  assert.equal(played.status, 'finished');
  assert.equal(played.effects.find((e) => e.type === 'item').status, 'pending', 'major loot waits for the GM');
  assert.equal(research.status, 'resolved', 'assisted research rolled from the sheet');

  // 18–21. The world moves through the three weeks: NPC routines, the merchant arrives in week two, the smugglers make
  // a major move that needs the GM. The GM reviews it all before anything is canon.
  const preview = await ok('POST', `/api/campaigns/${camp.id}/simulate`, { days: 21 }, gm);
  const seize = preview.developments.find((d) => d.source === 'Black Sail: Seize the old mill');
  assert.deepEqual([seize.significance, seize.status], ['major', 'undecided'], '20. a significant faction action needs approval');
  const arrival = preview.developments.find((d) => d.source === 'Scheduled: Jory reaches Greyhaven');
  assert.ok(arrival && arrival.time > (down.startDay + 7) * 1440 && arrival.time <= (down.startDay + 14) * 1440, '19. in the second week');
  assert.ok(preview.developments.filter((d) => d.source === 'Black Sail: Smuggling run').every((d) => d.reactions.some((r) => r.startsWith('Hilda'))));
  const queue = await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, gm);
  assert.equal(queue.windows[0].actions.length, 5, '21. the GM sees every pending action');

  // 22. The GM approves permitted rewards and consequences.
  const decisions = { [seize.id]: 'approved' };
  const final = await ok('POST', `/api/campaigns/${camp.id}/simulate`, { days: 21, decisions }, gm);
  await ok('POST', `/api/campaigns/${camp.id}/simulate/commit`, { days: 21, decisions, hash: final.hash }, gm);
  const item = played.effects.find((e) => e.type === 'item');
  await ok('PATCH', `/api/quest-runs/${runId}/effects`, { decisions: { [item.i]: 'approved' } }, gm);
  await ok('PATCH', `/api/downtime-actions/${research.id}`, { status: 'approved', outcome: { success: true, notes: 'The crown lies beneath the old mill.', rewardXp: 50 } }, gm);
  await ok('PATCH', `/api/downtime-actions/${guard.id}`, { status: 'approved', outcome: { success: true, notes: 'Captain Bren teaches you the shield wall.', rewardXp: 100 } }, gm);
  await ok('PATCH', `/api/downtime-actions/${trade.id}`, { status: 'approved', outcome: { success: true, notes: 'Hilda agrees to a discount for the party.' } }, gm);
  const published = await ok('POST', `/api/downtime/${down.id}/publish`, {}, gm);
  await ok('POST', `/api/campaigns/${camp.id}/world-changes`, { note: 'Kel\'s trading partnership with Hilda', effects: [{ kind: 'standing', factionId: smiths.id, target: 'party', delta: 25 }] }, gm);
  await ok('PATCH', `/api/quests/${crownQuest.id}`, { objectives: crownQuest.objectives.map((o, i) => ({ ...o, done: i === 0 })) }, gm);
  await ok('PATCH', `/api/pages/${artefact.id}`, { visibility: 'party' }, gm);

  // 23. Sheets, relationships, quests and world history are updated.
  const sheet = async (h, tok) => ok('GET', `/api/characters/${h.id}`, null, tok);
  assert.equal((await sheet(brann, p1)).xp, 400);
  assert.equal((await sheet(ilse, p2)).xp, 350);
  const tamSheet = await sheet(tam, p3);
  assert.equal(tamSheet.character.inventory.filter((i) => i.name === 'Smuggler\'s ledger').length, 1, 'no duplicate loot');
  assert.equal(tamSheet.character.currency.gp, 45);
  assert.ok(tamSheet.character.journal.some((j) => j.text === 'I found the ledger.'));
  assert.equal((await sheet(kel, p6)).character.currency.gp, 20, 'trade cost paid once');
  assert.equal((await sheet(wren, p5)).character.currency.gp, 37, 'a week of work');
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/quests`, null, p3)).find((q) => q.id === ledgerQuest.id).objectives[0].done, true);
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/quests`, null, p1)).find((q) => q.id === crownQuest.id).objectives[0].done, true);
  const w = await ok('GET', `/api/campaigns/${camp.id}/world`, null, gm);
  assert.ok(w.factions.find((f) => f.id === sail.id).current.territory.includes(mill.id), 'the approved seizure is canon');
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/world`, null, p1)).factions.find((f) => f.name === 'Smiths\' Guild').towardParty, 'friendly');
  assert.ok(w.history.some((x) => /Black Sail takes Old Mill/.test(x.text)) && w.history.some((x) => /standing toward the party \+25/.test(x.text)));
  const npcLog = await ok('GET', `/api/campaigns/${camp.id}/npc-log`, null, gm);
  assert.ok(npcLog.some((x) => /Hilda Ironhand.*(forge|tools|Drinking)/i.test(x.text)), '18. NPCs kept their routines');
  assert.ok(npcLog.some((x) => x.kind === 'override' && /Jory/.test(x.text)), '19. the merchant arrived');
  assert.ok(npcLog.some((x) => x.kind === 'reacted' && /Hilda Ironhand reacts to the smuggling/.test(x.text)));
  assert.equal(published.report.characters.length, 5);

  // 24. The next live session starts from the canonical state.
  await ok('PATCH', `/api/campaigns/${camp.id}/director`, { liveSceneId: tavernScene.id }, gm);
  const p1World = await ok('GET', `/api/worlds/${world.id}`, null, p1);
  assert.equal(p1World.campaigns[0].liveSceneId, tavernScene.id);
  const clock = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, p1)).clock;
  assert.equal(clock.day, down.endDay, 'three weeks later');
  assert.equal((await ok('GET', `/api/locations/${cave.id}`, null, p1)).location.name, 'Smugglers\' Cave', 'the discovered cave is on the map');
  assert.equal((await ok('GET', `/api/pages/${artefact.id}`, null, p1)).page.gmNotes, undefined, 'revealed lore, still without GM notes');
  const tavernNow = await ok('GET', `/api/scenes/${tavernScene.id}`, null, p1);
  assert.ok(tavernNow.tokens.some((x) => x.name === 'Mara'), 'Mara is serving in the common room');

  // Pass conditions.
  assert.equal(db.characters.length, 6, 'no duplicate characters');
  assert.equal(db.npcs.length, 3, 'no duplicate NPCs');
  assert.equal(db.factions.length, 2);
  assert.equal(new Set(db.tokens.filter((x) => x.npcId).map((x) => x.npcId)).size, db.tokens.filter((x) => x.npcId).length, 'one token per NPC at most');
  assert.ok(db.downtimeActions.every((a) => ['approved', 'rejected', 'cancelled'].includes(a.status)), 'nothing left half-decided');
  // No hidden information reached the spectator or the livestream.
  const seen = JSON.stringify([...tv.msgs, ...watch.msgs, await ok('GET', `/api/campaigns/${camp.id}/world`, null, viv), await ok('GET', `/api/worlds/${world.id}`, null, viv),
    await ok('GET', `/api/campaigns/${camp.id}/quests`, null, viv), await ok('GET', `/api/scenes/${dungeonScene.id}`, null, viv)]);
  assert.deepEqual([...new Set(seen.match(/SECRET-[a-z-]+/g) || [])], []);
  assert.ok(!seen.includes('Black Sail'));
  assert.ok(seen.includes('Brann'), 'the authorised presentation reached the stream');

  // On PostgreSQL: a restart brings back exactly this world.
  if (DB) {
    const before = JSON.parse(JSON.stringify(db));
    const again = await boot({ store: await postgresStore({ databaseUrl: DB }) });
    try { assert.deepEqual(again.app.db, before); } finally { await again.close(); }
  }
});
