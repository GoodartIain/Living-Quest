#!/usr/bin/env node
// Milestone 7 acceptance, run by hand: the GM goes on air from Director Mode; an OBS-like page (no login) shows only the
// public picture of the on-air scene (no hidden goblin, its turn or its roll), follows moves live, goes off air the moment
// the GM stops and comes back by itself; the 3D camera variant renders; a signed-in spectator sees the same tokens.
// Needs Playwright with Chromium and the app running: PORT=3930 npm start, then BASE_URL=http://localhost:3930 node scripts/acceptance-m7.js
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3930';
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();
(async () => {
  const gm = await api('POST', '/api/users', { name: 'GM' }); const viv = await api('POST', '/api/users', { name: 'Viv' });
  const world = await api('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm.token);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven Live' }, gm.token);
  await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, { role: 'spectator' }, gm.token)).code}/accept`, {}, viv.token);
  const town = await api('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 40, y: 40, visibility: 'public' }, gm.token);
  const market = await api('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', visibility: 'public', cols: 12, rows: 8 }, gm.token);
  const herald = await api('POST', `/api/scenes/${market.id}/tokens`, { name: 'Herald', x: 2, y: 2, visibility: 'public', color: '#2e86c1' }, gm.token);
  const gob = await api('POST', `/api/scenes/${market.id}/tokens`, { name: 'Goblin', x: 4, y: 3, visibility: 'gm' }, gm.token);
  await api('PATCH', `/api/scenes/${market.id}`, { walls: [{ x1: 6, y1: 0, x2: 6, y2: 5 }] }, gm.token);
  await api('PUT', `/api/scenes/${market.id}/encounter`, { combatants: [{ tokenId: herald.id, initiative: 14 }, { tokenId: gob.id, initiative: 18 }] }, gm.token);
  await api('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d20+2', label: 'Herald: Persuasion', sceneId: market.id }, gm.token);
  await api('POST', `/api/worlds/${world.id}/rolls`, { formula: '1d20', label: 'Goblin sneak', visibility: 'gm', sceneId: market.id }, gm.token);
  const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] }); const errs = [];
  const mk = async (t) => { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); if (t) await ctx.addInitScript((x) => localStorage.setItem('lq-token', x), t);
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(e.message)); return pg; };
  const g = await mk(gm.token);
  await g.goto(B); await g.click('li >> button:text-is("Aster")'); await g.click('button:text-is("director")');
  await g.waitForSelector('text=Livestream · off');
  // Milestone 12 panel: go on air, put the market in the show, take it, set the title.
  await g.click('#dir-stream button:text-is("Go on air")'); await g.waitForSelector('text=Livestream · ON AIR');
  const link = await g.inputValue('input[aria-label="Broadcast link"]'); // shown once
  await g.click('summary:text-is("Choose scenes")'); await g.check('#dir-stream label:has-text("Market") input'); await g.click('button:text-is("Save playlist")');
  await g.click('button:text-is("Take Market")'); await g.waitForSelector('.stream-preview:has-text("Market")'); // the panel redraws: type after it
  await g.fill('#dir-stream input[name=title]', 'Session 12'); await g.click('#dir-stream button:text-is("Save overlays")');
  await g.waitForSelector('#dir-stream input[name=title][value="Session 12"]');
  // OBS-like page: no login.
  const obs = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); obs.on('pageerror', (e) => errs.push(e.message));
  await obs.goto(link); await obs.waitForSelector('svg .tok'); await obs.waitForSelector('#title:has-text("Session 12")');
  const obsText = await obs.textContent('body');
  const offVisibleOnAir = await obs.isVisible('#off');
  const tokNames = await obs.$$eval('svg .tok text', (t) => t.map((x) => x.textContent));
  // Live update
  await api('PATCH', `/api/tokens/${herald.id}`, { x: 3, y: 2 }, gm.token);
  await obs.waitForFunction(() => document.querySelector('svg .tok').getAttribute('transform') === 'translate(3.5 2.5)', null, { timeout: 5000 });

  // Stop: off air at once; back on: the page reconnects by itself.
  await g.click('button:text-is("Stop streaming now")'); await obs.waitForSelector('#off', { state: 'visible', timeout: 5000 }); const offVisibleAfterStop = true;
  await g.waitForSelector('text=Livestream · off'); await g.click('#dir-stream button:text-is("Go on air")');
  await obs.waitForSelector('#off', { state: 'hidden', timeout: 15000 }); const backOnAir = true;
  // 3D tactical camera, chosen by the GM (Milestone 12 replaced the &view=3d link option).
  await g.selectOption('#dir-stream select[name=camera]', 'tactical');
  await obs.waitForSelector('#stage canvas', { timeout: 15000 }); await obs.waitForTimeout(800);
  await g.selectOption('#dir-stream select[name=camera]', 'board'); await obs.waitForSelector('#stage svg');
  // Signed-in spectator: same picture in the app.
  const v = await mk(viv.token); await v.goto(B); await v.click('li >> button:text-is("Aster")'); await v.waitForSelector('text=Characters'); await v.evaluate((id) => openScene(id), market.id); await v.waitForSelector('svg.board .tok');
  const vivNames = await v.$$eval('svg.board .tok title', (t) => t.map((x) => x.textContent));
  const ok = !offVisibleOnAir && offVisibleAfterStop && backOnAir && tokNames.join() === 'Herald' && !obsText.includes('Goblin') && obsText.includes('Session 12')
    && (await obs.textContent('#init')) === 'Herald (14)' && !(await obs.textContent('#rolls')).includes('Goblin') && vivNames.join() === 'Herald' && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL', { offVisibleOnAir, offVisibleAfterStop, backOnAir, tokNames, obsHasGoblin: obsText.includes('Goblin'), obsHasTitle: obsText.includes('Session 12'), obsInitiative: await obs.textContent('#init'), obsRolls: await obs.textContent('#rolls'), vivNames, errs });
  await b.close();
  process.exit(ok ? 0 : 1);
})();
