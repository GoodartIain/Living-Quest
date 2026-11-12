// Milestone 6: scene walls (shared by the 2D board and the 3D view) and their fog filtering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('walls: validation, live push, fog keeps unexplored layout hidden', async (t) => {
  const { call, ok, listen, close } = await boot();
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return close(); });
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const pat = (await ok('POST', '/api/users', { name: 'Pat' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, pat);
  const scene = await ok('POST', `/api/locations/${world.rootLocationId}/scenes`, { name: 'Room', cols: 10, rows: 8, visibility: 'party' }, gm);
  const walls = (w, tok = gm) => call('PATCH', `/api/scenes/${scene.id}`, { walls: w }, tok);
  assert.equal((await walls([{ x1: 0, y1: 0, x2: 3, y2: 3 }])).status, 400, 'diagonal');
  assert.equal((await walls([{ x1: 2, y1: 2, x2: 2, y2: 2 }])).status, 400, 'no length');
  assert.equal((await walls([{ x1: 0, y1: 0, x2: 11, y2: 0 }])).status, 400, 'outside the scene');
  assert.equal((await walls([{ x1: 0, y1: 0, x2: 4, y2: 0 }], pat)).status, 403);
  const live = await listen(scene.id, pat);
  streams.push(live);
  // A 4x3 room in the corner and a wall far away.
  const room = [{ x1: 0, y1: 0, x2: 4, y2: 0 }, { x1: 4, y1: 0, x2: 4, y2: 3 }, { x1: 0, y1: 3, x2: 4, y2: 3 }, { x1: 0, y1: 0, x2: 0, y2: 3 }, { x1: 8, y1: 5, x2: 8, y2: 8 }];
  await ok('PATCH', `/api/scenes/${scene.id}`, { walls: room }, gm);
  await live.until((m) => m.data.scene.walls.length === 5);
  // Fog on, only the room's left half explored.
  await ok('PATCH', `/api/scenes/${scene.id}`, { fogEnabled: true }, gm);
  await ok('POST', `/api/scenes/${scene.id}/fog`, { x0: 0, y0: 0, x1: 1, y1: 2, reveal: true }, gm);
  const seen = (await live.until((m) => m.data.scene.fog.revealed.length === 6)).data.scene.walls;
  const key = (w) => `${w.x1},${w.y1}-${w.x2},${w.y2}`;
  assert.deepEqual(seen.map(key).sort(), ['0,0-0,1', '0,0-1,0', '0,1-0,2', '0,2-0,3', '0,3-1,3', '1,0-2,0', '1,3-2,3'].sort(),
    'only the unit pieces bordering explored cells; nothing from the far wall');
  assert.equal((await ok('GET', `/api/scenes/${scene.id}`, null, gm)).scene.walls.length, 5, 'the GM always sees all walls');
  assert.equal((await call('PATCH', `/api/scenes/${scene.id}`, { cols: 6 }, gm)).status, 409, 'a wall at x=8 blocks shrinking');
});
