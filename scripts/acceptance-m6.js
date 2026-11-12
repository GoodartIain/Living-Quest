#!/usr/bin/env node
// Milestone 6 acceptance, run by hand: a player explores a walled room in 3D first person (walls stop them),
// switches to tactical, and every view (3D, the GM's 2D board, the server) agrees on where the character is;
// hidden tokens never appear. Needs Playwright with Chromium and the app running, e.g.:
//   PORT=3929 npm start   then   BASE_URL=http://localhost:3929 node scripts/acceptance-m6.js
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3929';
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();
(async () => {
  const gm = await api('POST', '/api/users', { name: 'GM' }); const pat = await api('POST', '/api/users', { name: 'Pat' });
  const world = await api('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm.token);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm.token);
  await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, {}, gm.token)).code}/accept`, {}, pat.token);
  const scene = await api('POST', `/api/locations/${world.rootLocationId}/scenes`, { name: 'Cellar', cols: 10, rows: 8, visibility: 'party' }, gm.token);
  // A 6x5 room with walls on all four sides.
  await api('PATCH', `/api/scenes/${scene.id}`, { walls: [{ x1: 1, y1: 1, x2: 7, y2: 1 }, { x1: 7, y1: 1, x2: 7, y2: 6 }, { x1: 1, y1: 6, x2: 7, y2: 6 }, { x1: 1, y1: 1, x2: 1, y2: 6 }] }, gm.token);
  const ch = (await api('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat.token)).character;
  const hero = await api('POST', `/api/scenes/${scene.id}/tokens`, { name: 'x', x: 3, y: 4, characterId: ch.id }, gm.token);
  await api('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Ally', x: 5, y: 2, color: '#2e86c1' }, gm.token);
  await api('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Goblin', x: 2, y: 2, visibility: 'gm' }, gm.token);
  const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] }); const errs = [];
  const page = async (t) => { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.addInitScript((x) => localStorage.setItem('lq-token', x), t);
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 160)));
    await pg.goto(B); await pg.click('li >> button:text-is("Aster")'); await pg.waitForSelector('text=Characters'); await pg.evaluate((id) => openScene(id), scene.id); await pg.waitForSelector('svg.board'); return pg; };
  const g = await page(gm.token), p = await page(pat.token);
  const wallsIn2d = await p.$$eval('svg.board path[stroke="#3b2f22"]', (x) => x.length);
  // First person
  await p.click('button:text-is("3D first person")'); await p.waitForFunction(() => state.scene.three && state.scene.three.mode === 'first', null, { timeout: 15000 });
  const tokensIn3d = () => p.evaluate(() => state.scene.three.world.children.filter((o) => o.userData.token).map((o) => [state.scene.view.tokens.find((t) => t.id === o.userData.token).name, o.visible, +o.position.x.toFixed(2), +o.position.z.toFixed(2)]));
  const wallMeshes = await p.evaluate(() => state.scene.three.world.children.filter((o) => o.userData.wall).length);
  const start = await p.evaluate(() => state.scene.three.camera.position.toArray().map((v) => +v.toFixed(2)));
  const fp = await tokensIn3d();
  const pixels = await p.evaluate(() => { const c = document.querySelector('#board canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); return !!gl; });
  // Walk forward (towards -z, the north wall at z=1) for a while: the wall must stop us inside the room.
  await p.focus('#board canvas'); await p.keyboard.down('w'); await p.waitForTimeout(2500); await p.keyboard.up('w'); await p.waitForTimeout(700);
  const after = await p.evaluate(() => state.scene.three.camera.position.toArray().map((v) => +v.toFixed(2)));
  // Turn and walk east a little.
  await p.keyboard.down('d'); await p.waitForTimeout(500); await p.keyboard.up('d'); await p.waitForTimeout(800);
  const stored = (await api('GET', `/api/scenes/${scene.id}`, null, gm.token)).tokens.find((t) => t.id === hero.id);
  const gmSees = await g.evaluate((id) => state.scene.view.tokens.find((t) => t.id === id), hero.id);
  // Tactical view: same tokens, our hero visible where the server says it is.
  await p.click('button:text-is("3D tactical")'); await p.waitForFunction(() => state.scene.three.mode === 'tactical');
  await p.waitForTimeout(300);
  const tac = await tokensIn3d();
  const tacCam = await p.evaluate(() => +state.scene.three.camera.position.y.toFixed(1));
  // Back to 2D: same position.
  await p.click('button:text-is("2D board")'); await p.waitForSelector('svg.board');
  const in2d = await p.$eval(`svg.board .tok[data-id="${hero.id}"]`, (e) => e.getAttribute('transform'));
  const ok = wallMeshes === 4 && after[2] >= 1.24 && after[2] < start[2] && stored.x === gmSees.x && stored.y === gmSees.y
    && tac.find((t) => t[0] === 'Brann')[2] === stored.x + 0.5 && tac.find((t) => t[0] === 'Brann')[3] === stored.y + 0.5
    && in2d === `translate(${stored.x + 0.5} ${stored.y + 0.5})` && !fp.find((t) => t[0] === 'Brann')[1] && !JSON.stringify(fp.concat(tac)).includes('Goblin') && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL', { wallsIn2d, wallMeshes, webgl: pixels, start, afterWalkNorth: after, insideRoom: after[2] >= 1.24, stored: [stored.x, stored.y], gmSees: [gmSees.x, gmSees.y],
    firstPerson: fp, tactical: tac, tacticalCameraHeight: tacCam, in2d, goblinLeaked: JSON.stringify(fp.concat(tac)).includes('Goblin'), errs });
  await b.close();
  process.exit(ok ? 0 : 1);
})();
