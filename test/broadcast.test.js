// Milestone 7 acceptance: a spectator (signed in, or watching the livestream) sees the authorised presentation but
// never hidden encounters, private messages, GM notes or undiscovered map areas. Every secret below carries "SECRET".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('no secret reaches a spectator or the livestream', async (t) => {
  const { call, ok, listen, listenTo, close } = await boot();
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return close(); });
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven Live' }, gm);
  const join = async (name, role) => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const pat = await join('Pat', 'player');
  const ana = await join('Ana', 'player');
  const viv = await join('Viv', 'spectator');
  const ids = Object.fromEntries((await ok('GET', `/api/campaigns/${camp.id}/chat`, null, gm)).members.map((m) => [m.name, m.userId]));

  // Map: a public town; inside it a party-only tavern, an undiscovered crypt and a public square.
  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 1, y: 1, visibility: 'public' }, gm);
  await ok('POST', `/api/locations/${town.id}/children`, { name: 'SECRET-tavern', x: 2, y: 2, visibility: 'party' }, gm);
  await ok('POST', `/api/locations/${town.id}/children`, { name: 'SECRET-crypt', x: 3, y: 3, visibility: 'public', requiresDiscovery: true }, gm);
  await ok('PATCH', `/api/pages/${town.pageId}`, { body: 'A port town.', gmNotes: 'SECRET-pagenote' }, gm);
  const page = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'SECRET-page', kind: 'npc', visibility: 'gm' }, gm);
  const herald = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'Town Herald', kind: 'npc', visibility: 'public' }, gm);
  await ok('POST', `/api/worlds/${world.id}/relationships`, { fromId: herald.id, toId: page.id, kind: 'SECRET-rel' }, gm);
  // Scenes: a public market (on air) and a GM-only lair.
  const market = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', visibility: 'public', cols: 10, rows: 8 }, gm);
  await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'SECRET-scene', visibility: 'gm' }, gm);
  const heraldTok = await ok('POST', `/api/scenes/${market.id}/tokens`, { name: 'Herald', x: 1, y: 1, visibility: 'public' }, gm);
  const goblin = await ok('POST', `/api/scenes/${market.id}/tokens`, { name: 'SECRET-goblin', x: 2, y: 1, visibility: 'gm' }, gm);
  await ok('POST', `/api/scenes/${market.id}/tokens`, { name: 'SECRET-partytoken', x: 3, y: 1, visibility: 'party' }, gm);
  await ok('POST', `/api/scenes/${market.id}/tokens`, { name: 'SECRET-fogged', x: 8, y: 6, visibility: 'public' }, gm);
  await ok('PATCH', `/api/scenes/${market.id}`, { fogEnabled: true, walls: [{ x1: 9, y1: 0, x2: 9, y2: 8 }] }, gm);
  await ok('POST', `/api/scenes/${market.id}/fog`, { x0: 0, y0: 0, x1: 4, y1: 3, reveal: true }, gm);
  await ok('PUT', `/api/scenes/${market.id}/encounter`, { combatants: [{ tokenId: goblin.id, initiative: 20 }, { tokenId: heraldTok.id, initiative: 5 }] }, gm);
  // Director, chat, rolls, journal.
  // NPCs: a party-only and a GM-only one standing in the public town and on the on-air scene; a world event in the history.
  await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'SECRET-partynpc', visibility: 'party', schedule: [{ from: '00:00', locationId: town.id, activity: 'SECRET-activity', sceneId: market.id, x: 1, y: 2 }] }, gm);
  await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'SECRET-spy', visibility: 'gm', schedule: [{ from: '00:00', locationId: town.id, activity: 'Watching', sceneId: market.id, x: 2, y: 2 }] }, gm);
  await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'Baker', visibility: 'public', schedule: [{ from: '00:00', locationId: town.id, activity: 'Baking' }] }, gm);
  await ok('POST', `/api/campaigns/${camp.id}/events`, { kind: 'SECRET-event' }, gm);
  // Milestone 10: a hidden quest, adventure text, and a public marker whose text and actions are private.
  await ok('POST', `/api/campaigns/${camp.id}/quests`, { title: 'SECRET-quest', visibility: 'gm' }, gm);
  await ok('POST', `/api/campaigns/${camp.id}/quests`, { title: 'Party quest', notes: 'SECRET-questnote' }, gm);
  await ok('POST', `/api/worlds/${world.id}/adventures`, { title: 'SECRET-adventure', nodes: { start: { text: 'SECRET-node' } } }, gm);
  await ok('POST', `/api/scenes/${market.id}/triggers`, { name: 'Well', x: 1, y: 3, visibility: 'public', text: 'SECRET-triggertext', event: { kind: 'SECRET-triggerevent' } }, gm);
  await ok('PATCH', `/api/campaigns/${camp.id}/director`, { notes: 'SECRET-notes', beats: [{ text: 'SECRET-beat' }], liveSceneId: market.id }, gm);
  await ok('POST', `/api/campaigns/${camp.id}/chat`, { channel: 'whisper', toUserIds: [ids.Ana], text: 'SECRET-whisper' }, pat);
  await ok('POST', `/api/campaigns/${camp.id}/chat`, { channel: 'table', text: 'SECRET-table' }, pat);
  await ok('POST', `/api/campaigns/${camp.id}/chat`, { channel: 'gm', text: 'SECRET-gmchat' }, gm);
  await ok('POST', `/api/campaigns/${camp.id}/chat`, { channel: 'audience', text: 'Hello stream!' }, viv);
  await ok('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d20', label: 'SECRET-privateroll', visibility: 'private', sceneId: market.id }, pat);
  await ok('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d20', label: 'SECRET-gmroll', visibility: 'gm', sceneId: market.id }, gm);
  await ok('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d20', label: 'Public cheer', visibility: 'public', sceneId: market.id }, ana);
  const brann = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat)).character;
  await ok('POST', `/api/characters/${brann.id}/journal`, { text: 'SECRET-journal', visibility: 'private' }, pat);

  // Livestream: off until the GM enables it; only the GM controls it.
  assert.equal((await listenTo('/api/broadcast/stream', 'nope', 'key')).status, 404);
  assert.equal((await call('PATCH', `/api/campaigns/${camp.id}/broadcast`, { enabled: true }, viv)).status, 403);
  assert.equal((await call('PATCH', `/api/campaigns/${camp.id}/broadcast`, { enabled: true }, pat)).status, 403);
  const on = await ok('PATCH', `/api/campaigns/${camp.id}/broadcast`, { enabled: true, sceneId: market.id, title: 'Session 12' }, gm);
  assert.ok(on.key && !('keyHash' in on));
  const tv = await listenTo('/api/broadcast/stream', on.key, 'key');
  streams.push(tv);
  const first = (await tv.until((m) => m.event === 'state')).data;
  assert.deepEqual(first.scene.tokens.map((x) => x.name), ['Herald']);
  assert.deepEqual(first.scene.encounter.combatants.map((x) => x.tokenId), [heraldTok.id]);
  assert.equal(first.scene.encounter.turnTokenId, null, "the hidden goblin's turn is not shown");
  assert.deepEqual(first.scene.rolls.map((r) => r.label), ['Public cheer']);
  assert.equal(first.title, 'Session 12');
  // Live: a public move shows up on stream.
  await ok('PATCH', `/api/tokens/${heraldTok.id}`, { x: 2, y: 2 }, gm);
  await tv.until((m) => m.event === 'state' && m.data.scene.tokens.some((x) => x.id === heraldTok.id && x.x === 2));

  // Sweep everything a signed-in spectator can reach.
  const seen = [];
  const get = async (url) => { const r = await call('GET', url, null, viv); seen.push(r.body); return r; };
  await get('/api/me');
  await get(`/api/worlds/${world.id}`);
  const crawl = async (id) => { const r = await get(`/api/locations/${id}`); if (r.status === 200) for (const c of r.body.children) await crawl(c.id); };
  await crawl(world.rootLocationId);
  for (const p of (await get(`/api/worlds/${world.id}/pages`)).body) await get(`/api/pages/${p.id}`);
  for (const q of ['SECRET', 'notes', 'goblin']) await get(`/api/worlds/${world.id}/pages?q=${q}`);
  await get(`/api/worlds/${world.id}/npcs`); await get(`/api/campaigns/${camp.id}/npc-log`);
  await get(`/api/campaigns/${camp.id}/quests`); await get(`/api/worlds/${world.id}/adventures`);
  for (const s of (await get(`/api/worlds/${world.id}/scenes`)).body) await get(`/api/scenes/${s.id}`);
  await get(`/api/campaigns/${camp.id}/chat`);
  for (const c of (await get(`/api/campaigns/${camp.id}/characters`)).body) await get(`/api/characters/${c.id}`);
  await get(`/api/worlds/${world.id}/rolls`);
  await get(`/api/campaigns/${camp.id}/voice`);
  await get(`/api/worlds/${world.id}/homebrew`);
  const sceneLive = await listen(market.id, viv);
  const chatLive = await listenTo(`/api/campaigns/${camp.id}/chat/stream`, viv);
  streams.push(sceneLive, chatLive);
  await sceneLive.until(() => true); await chatLive.until(() => true);
  assert.equal((await call('GET', `/api/campaigns/${camp.id}/broadcast`, null, viv)).status, 403);
  assert.equal((await call('PATCH', `/api/campaigns/${camp.id}/director`, { notes: 'x' }, viv)).status, 403);
  const everything = JSON.stringify([seen, sceneLive.msgs, chatLive.msgs, tv.msgs]);
  const leaks = [...new Set(everything.match(/SECRET-[a-z]+/g) || [])];
  assert.deepEqual(leaks, [], `leaked to the spectator or stream: ${leaks.join(', ')}`);
  assert.ok(everything.includes('Hello stream!') && everything.includes('Town Herald') && everything.includes('Herald') && everything.includes('Baker') && everything.includes('Well'), 'the authorised content is there');

  // Stopping is immediate; rotating the link retires the old one.
  await ok('PATCH', `/api/campaigns/${camp.id}/broadcast`, { enabled: false }, gm);
  await tv.until((m) => m.event === 'off');
  assert.equal((await listenTo('/api/broadcast/stream', on.key, 'key')).status, 404);
  const re = await ok('PATCH', `/api/campaigns/${camp.id}/broadcast`, { enabled: true, rotateKey: true }, gm);
  assert.equal((await listenTo('/api/broadcast/stream', on.key, 'key')).status, 404, 'the old link is dead');
  const tv2 = await listenTo('/api/broadcast/stream', re.key, 'key');
  streams.push(tv2);
  assert.equal((await tv2.until(() => true)).data.onAir, true);
  // A GM-only scene put on air shows nothing.
  const lair = (await ok('GET', `/api/worlds/${world.id}/scenes`, null, gm)).find((s) => s.name === 'SECRET-scene');
  await ok('PATCH', `/api/campaigns/${camp.id}/broadcast`, { sceneId: lair.id }, gm);
  const hidden = (await tv2.until((m) => m.data.notPublic)).data;
  assert.equal(hidden.scene, null);
  assert.ok(!JSON.stringify(tv2.msgs).includes('SECRET'));
});
