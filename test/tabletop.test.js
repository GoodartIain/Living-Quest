// Milestone 3 acceptance: a GM and six players share a scene with correct visibility and permissions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('GM and six players share a live scene', async (t) => {
  const { call, ok, listen, close } = await boot();
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return close(); });
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C1' }, gm);
  const join = async (name, role = 'player') => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const players = [];
  for (let i = 1; i <= 6; i++) players.push(await join(`P${i}`));
  const spectator = await join('Viv', 'spectator');
  const outsider = await user('Out');
  const ids = (await ok('GET', `/api/worlds/${world.id}`, null, gm)).members.filter((m) => m.role === 'player').map((m) => m.userId);
  assert.equal(ids.length, 6);

  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 50, y: 50, visibility: 'public' }, gm);
  const scene = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', cols: 20, rows: 15 }, gm);
  assert.equal((await call('GET', `/api/scenes/${scene.id}`, null, players[0])).status, 404, 'scenes start GM-only');
  assert.equal((await call('POST', `/api/locations/${town.id}/scenes`, { name: 'X' }, players[0])).status, 403);
  await ok('PATCH', `/api/scenes/${scene.id}`, { visibility: 'party' }, gm);
  assert.deepEqual((await ok('GET', `/api/locations/${town.id}`, null, players[0])).scenes.map((s) => s.name), ['Market']);
  assert.deepEqual((await ok('GET', `/api/locations/${town.id}`, null, spectator)).scenes, []);

  const heroes = [];
  for (let i = 0; i < 6; i++) {
    heroes.push(await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: `Hero${i + 1}`, x: i, y: 0, controlledBy: [ids[i]] }, gm));
  }
  await ok('PATCH', `/api/tokens/${heroes[5].id}`, { x: 18, y: 14 }, gm); // Hero6 scouts ahead into the dark
  const goblin = await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Goblin', x: 3, y: 3, visibility: 'gm' }, gm);
  const ally = await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Ally', x: 10, y: 10 }, gm);
  assert.equal((await call('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Off', x: 20, y: 0 }, gm)).status, 400);
  assert.equal((await call('POST', `/api/scenes/${scene.id}/tokens`, { name: 'X', x: 1, y: 1, controlledBy: ['nobody'] }, gm)).status, 400);

  // Everyone subscribes.
  const live = await Promise.all(players.map((p) => listen(scene.id, p)));
  const gmLive = await listen(scene.id, gm);
  streams.push(...live, gmLive);
  assert.equal((await listen(scene.id, outsider)).status, 404);
  assert.equal((await listen(scene.id, spectator)).status, 404, 'party scene is not public');
  const names = (m) => m.data.tokens.map((x) => x.name).sort();
  for (const s of live) assert.deepEqual(names(await s.until(() => true)), ['Ally', 'Hero1', 'Hero2', 'Hero3', 'Hero4', 'Hero5', 'Hero6']);
  assert.ok(names(await gmLive.until(() => true)).includes('Goblin'));

  // Fog: only revealed cells show, except your own token.
  await ok('PATCH', `/api/scenes/${scene.id}`, { fogEnabled: true }, gm);
  await ok('POST', `/api/scenes/${scene.id}/fog`, { x0: 0, y0: 0, x1: 5, y1: 4, reveal: true }, gm);
  const fogged = (s) => s.until((m) => m.data.scene.fog.revealed.length === 30);
  assert.deepEqual(names(await fogged(live[0])), ['Hero1', 'Hero2', 'Hero3', 'Hero4', 'Hero5'], 'goblin in a revealed cell stays GM-only');
  assert.deepEqual(names(await fogged(live[5])), ['Hero1', 'Hero2', 'Hero3', 'Hero4', 'Hero5', 'Hero6']);

  // Movement: own token only, position only, in bounds; every player sees it live.
  await ok('PATCH', `/api/tokens/${heroes[0].id}`, { x: 4, y: 2 }, players[0]);
  for (const s of live) await s.until((m) => m.data.tokens.some((x) => x.name === 'Hero1' && x.x === 4 && x.y === 2));
  assert.equal((await call('PATCH', `/api/tokens/${heroes[1].id}`, { x: 1, y: 1 }, players[0])).status, 403);
  assert.equal((await call('PATCH', `/api/tokens/${heroes[0].id}`, { name: 'Boss' }, players[0])).status, 403);
  assert.equal((await call('PATCH', `/api/tokens/${heroes[0].id}`, { x: 99, y: 0 }, players[0])).status, 400);
  assert.equal((await call('PATCH', `/api/tokens/${goblin.id}`, { x: 1, y: 1 }, players[0])).status, 403);
  assert.equal((await call('PATCH', `/api/tokens/${heroes[0].id}`, { x: 1, y: 1 }, spectator)).status, 403);
  assert.equal((await call('POST', `/api/scenes/${scene.id}/fog`, { x0: 0, y0: 0, x1: 19, y1: 14, reveal: true }, players[0])).status, 403);
  await ok('PATCH', `/api/tokens/${heroes[0].id}`, { x: 4.6, y: 2.2 }, players[0]);
  assert.deepEqual((await ok('GET', `/api/scenes/${scene.id}`, null, gm)).tokens.find((x) => x.name === 'Hero1').x, 5, 'square grid snaps');

  // Encounter: hidden combatants and their turns stay hidden.
  await ok('PUT', `/api/scenes/${scene.id}/encounter`, { combatants: [
    { tokenId: heroes[0].id, initiative: 15 }, { tokenId: goblin.id, initiative: 20 }, { tokenId: heroes[1].id, initiative: 10 }] }, gm);
  const enc = (await live[0].until((m) => m.data.encounter)).data.encounter;
  assert.deepEqual(enc.combatants.map((c) => c.tokenId), [heroes[0].id, heroes[1].id]);
  assert.equal(enc.turnTokenId, null, "the goblin's turn is not revealed");
  await ok('POST', `/api/scenes/${scene.id}/encounter/next`, null, gm);
  await live[3].until((m) => m.data.encounter && m.data.encounter.turnTokenId === heroes[0].id);
  await ok('POST', `/api/scenes/${scene.id}/encounter/next`, null, gm);
  await ok('POST', `/api/scenes/${scene.id}/encounter/next`, null, gm);
  assert.equal((await gmLive.until((m) => m.data.encounter && m.data.encounter.round === 2)).data.encounter.turnTokenId, goblin.id);
  assert.equal((await call('POST', `/api/scenes/${scene.id}/encounter/next`, null, players[0])).status, 403);
  await ok('DELETE', `/api/tokens/${goblin.id}`, null, gm);
  assert.equal((await ok('GET', `/api/scenes/${scene.id}`, null, gm)).encounter.combatants.length, 2);

  // Nothing GM-only ever reached any player's stream.
  for (const s of live) assert.ok(!JSON.stringify(s.msgs).includes('Goblin'));
  for (const s of live) assert.ok(!JSON.stringify(s.msgs).includes('controlledBy'));

  // Hiding the scene closes player streams.
  await ok('PATCH', `/api/scenes/${scene.id}`, { visibility: 'gm' }, gm);
  for (const s of live) await s.until((m) => m.event === 'gone');
  assert.equal((await call('PATCH', `/api/tokens/${heroes[0].id}`, { x: 1, y: 1 }, players[0])).status, 404);
});
