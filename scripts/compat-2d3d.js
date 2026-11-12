#!/usr/bin/env node
// 2D/3D compatibility check (Milestone 13). One scene using every feature (fog, walls, triggers, tokens of several sizes
// and visibilities, an NPC token, a character token, an encounter) is opened by the GM, a player and a spectator in the
// 2D board, the 3D tactical view and 3D first person, and on the livestream page in 2D and 3D. In every view the tokens
// drawn must be exactly the tokens the server sent that viewer, and no page may throw.
//   PORT=3926 npm start
//   BASE_URL=http://localhost:3926 node scripts/compat-2d3d.js
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3926';
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();
(async () => {
  const gm = (await api('POST', '/api/users', { name: 'GM' })).token;
  const world = await api('POST', '/api/worlds', { name: 'Compat', advancement: 'xp', npcAutonomy: 'scheduled' }, gm);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const join = async (name, role) => { const t = (await api('POST', '/api/users', { name })).token; await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, t); return t; };
  const pat = await join('Pat', 'player');
  const viv = await join('Viv', 'spectator');
  const ch = (await api('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat)).character;
  const town = await api('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Town', x: 1, y: 1, visibility: 'public' }, gm);
  const s = await api('POST', `/api/locations/${town.id}/scenes`, { name: 'Everything', visibility: 'public', cols: 14, rows: 10 }, gm);
  const me = (await api('GET', `/api/worlds/${world.id}`, null, gm)).members.find((m) => m.name === 'Pat').userId;
  const hero = await api('POST', `/api/scenes/${s.id}/tokens`, { name: 'Brann', x: 2, y: 2, characterId: ch.id, controlledBy: [me], visibility: 'public' }, gm);
  const ogre = await api('POST', `/api/scenes/${s.id}/tokens`, { name: 'Ogre', x: 5, y: 2, size: 2, visibility: 'public' }, gm);
  await api('POST', `/api/scenes/${s.id}/tokens`, { name: 'Dragon', x: 9, y: 5, size: 3, visibility: 'party' }, gm);
  await api('POST', `/api/scenes/${s.id}/tokens`, { name: 'Assassin', x: 4, y: 4, visibility: 'gm' }, gm);
  await api('POST', `/api/scenes/${s.id}/tokens`, { name: 'Fogged imp', x: 12, y: 8, visibility: 'public' }, gm);
  await api('POST', `/api/worlds/${world.id}/npcs`, { name: 'Baker', visibility: 'public', schedule: [{ from: '00:00', locationId: town.id, activity: 'Baking', sceneId: s.id, x: 1, y: 6 }] }, gm);
  await api('PATCH', `/api/scenes/${s.id}`, { fogEnabled: true, walls: [{ x1: 7, y1: 0, x2: 7, y2: 4 }, { x1: 0, y1: 5, x2: 4, y2: 5 }] }, gm);
  await api('POST', `/api/scenes/${s.id}/fog`, { x0: 0, y0: 0, x1: 11, y1: 7, reveal: true }, gm);
  await api('POST', `/api/scenes/${s.id}/triggers`, { name: 'Lever', x: 3, y: 3, visibility: 'public' }, gm);
  await api('PUT', `/api/scenes/${s.id}/encounter`, { combatants: [{ tokenId: hero.id, initiative: 15 }, { tokenId: ogre.id, initiative: 9 }] }, gm);
  const bc = await api('PATCH', `/api/campaigns/${camp.id}/broadcast`, { enabled: true, sceneId: s.id }, gm);

  const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const errs = [];
  const results = [];
  for (const [who, tok] of [['GM', gm], ['player', pat], ['spectator', viv]]) {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
    await ctx.addInitScript((x) => localStorage.setItem('lq-token', x), tok);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    await p.goto(B); await p.click('li >> button:text-is("Compat")'); await p.waitForFunction(() => state.world && state.loc);
    await p.evaluate((id) => openScene(id), s.id); await p.waitForSelector('svg.board');
    const sent = (await p.evaluate(() => state.scene.view.tokens.map((t) => t.name))).sort();
    const drawn2d = (await p.$$eval('svg.board .tok text', (t) => t.map((x) => x.textContent))).sort();
    results.push({ who, view: '2d', sent, drawn: drawn2d, triggers: await p.locator('svg.board .trig').count() });
    for (const view of ['tactical', 'first']) {
      await p.click(`button:text-is("${view === 'tactical' ? '3D tactical' : '3D first person'}")`);
      await p.waitForFunction(() => state.scene.three && state.scene.three.mode, null, { timeout: 15000 });
      await p.waitForTimeout(300);
      const drawn = (await p.evaluate(() => state.scene.three.world.children.filter((o) => o.userData.token).map((o) => state.scene.view.tokens.find((t) => t.id === o.userData.token).name))).sort();
      const triggers = await p.evaluate(() => state.scene.three.world.children.filter((o) => o.userData.trigger).length);
      results.push({ who, view, sent, drawn, triggers });
    }
    await ctx.close();
  }
  for (const camera of ['board', 'tactical']) {
    await api('PATCH', `/api/campaigns/${camp.id}/broadcast`, { camera }, gm);
    const o = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
    o.on('pageerror', (e) => errs.push(`stream: ${e.message}`));
    await o.goto(`${B}/broadcast.html#key=${bc.key}`);
    await o.waitForSelector(camera === 'board' ? '#stage svg' : '#stage canvas', { timeout: 15000 });
    const drawn = camera === 'board' ? (await o.$$eval('#stage .tok text', (t) => t.map((x) => x.textContent))).sort() : null;
    results.push({ who: 'livestream', view: camera, sent: null, drawn });
  }
  const spectatorSees = results.find((r) => r.who === 'spectator').sent;
  const playerSees = results.find((r) => r.who === 'player').sent;
  const bad = results.filter((r) => r.sent && r.drawn.join() !== r.sent.join());
  const ok = !bad.length && !errs.length && results.filter((r) => r.who === 'GM').every((r) => r.sent.length === 6)
    && playerSees.join() === 'Baker,Brann,Dragon,Ogre' && spectatorSees.join() === 'Baker,Brann,Ogre'
    && results.find((r) => r.who === 'livestream' && r.view === 'board').drawn.join() === spectatorSees.join()
    && results.filter((r) => r.triggers !== undefined).every((r) => r.triggers === 1);
  console.log(ok ? 'PASS' : 'FAIL', JSON.stringify({ results: results.map((r) => `${r.who}/${r.view}: ${r.drawn ? r.drawn.join(',') : 'rendered'}${r.triggers !== undefined ? ` +${r.triggers} trigger` : ''}`), bad, errs }, null, 1));
  await b.close();
  process.exit(ok ? 0 : 1);
})();
