#!/usr/bin/env node
// Milestone 12 acceptance, run by hand through the real UI: the GM runs a public-safe presentation from Director Mode
// (scene playlist, cameras, title card, overlays, party panel with player consent, an audience poll and reactions) while
// keeping private controls; the OBS page shows only what a spectator may see. Then the GM edits walls and a trigger in 3D.
//   PORT=3926 npm start
//   BASE_URL=http://localhost:3926 node scripts/acceptance-m12.js
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3926';
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();
(async () => {
  const gm = await api('POST', '/api/users', { name: 'GM' });
  const world = await api('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm.token);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven Live' }, gm.token);
  const join = async (name, role) => {
    const u = await api('POST', '/api/users', { name });
    await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm.token)).code}/accept`, {}, u.token);
    return u;
  };
  const pat = await join('Pat', 'player');
  const viv = await join('Viv', 'spectator');
  const brann = (await api('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat.token)).character;
  const town = await api('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 40, y: 40, visibility: 'public' }, gm.token);
  const tavern = await api('POST', `/api/locations/${town.id}/scenes`, { name: 'Tavern', visibility: 'public', cols: 10, rows: 8 }, gm.token);
  const market = await api('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', visibility: 'public' }, gm.token);
  await api('POST', `/api/locations/${town.id}/scenes`, { name: 'Crypt', visibility: 'gm' }, gm.token);
  await api('POST', `/api/scenes/${tavern.id}/tokens`, { name: 'Herald', x: 2, y: 2, visibility: 'public' }, gm.token);
  await api('POST', `/api/scenes/${tavern.id}/tokens`, { name: 'Hidden goblin', x: 5, y: 5, visibility: 'gm' }, gm.token);
  await api('PATCH', `/api/campaigns/${camp.id}/director`, { notes: 'The herald is a spy.' }, gm.token);

  const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const errs = [];
  const page = async (token, who, url = B, size = { width: 1200, height: 1000 }) => {
    const ctx = await b.newContext({ viewport: size });
    if (token) await ctx.addInitScript((tok) => localStorage.setItem('lq-token', tok), token);
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    pg.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Herald reveals the news' : undefined));
    await pg.goto(url);
    if (token) { await pg.click('li >> button:text-is("Aster")'); await pg.waitForFunction(() => state.world && state.loc); }
    return pg;
  };
  // Pat agrees to show Brann on stream, on the sheet.
  const p = await page(pat.token, 'Pat');
  await p.evaluate((id) => openCharacter(id), brann.id);
  await p.check('input[name=onStream]');
  await p.waitForFunction(() => state.character.character.onStream === true);

  // GM: Director Mode → go on air, choose the show's scenes, take the tavern.
  const g = await page(gm.token, 'GM');
  await g.click('button:text-is("director")');
  await g.click('.stream-panel button:text-is("Go on air")');
  const link = await g.inputValue('input[aria-label="Broadcast link"]');
  await g.click('summary:text-is("Choose scenes")');
  for (const name of ['Tavern', 'Market', 'Crypt']) await g.check(`.stream-panel label:has-text("${name}") input`);
  await g.click('button:text-is("Save playlist")');
  await g.click('button:text-is("Take Tavern")');
  await g.waitForSelector('.stream-preview:has-text("Tavern")');
  await g.fill('.stream-panel input[name=lowerThird]', 'Session 12: The Herald\'s News');
  await g.fill('.stream-panel input[name=brandText]', 'Sponsored by the Dice Tower Inn');
  await g.selectOption('.stream-panel select[name=showParty]', 'health');
  await g.check('.stream-panel input[name=reactions]');
  await g.click('button:text-is("Save overlays")');
  await g.waitForSelector('.stream-preview:has-text("party: Brann")');
  await g.fill('.stream-panel input[name=q]', 'Where next?');
  await g.fill('.stream-panel textarea[name=opts]', 'The crypt\nThe docks');
  await g.click('button:text-is("Start poll")');

  // OBS page.
  const obs = await page(null, 'OBS', link, { width: 1920, height: 1080 });
  await obs.waitForSelector('#stage svg');
  const obsBoard = await obs.textContent('#stage');
  const obsLower = await obs.textContent('#lower');
  const obsBrand = await obs.textContent('#brand');
  const obsParty = await obs.textContent('#party');
  const hpBar = await obs.$('#party .bar');

  // Spectator votes and reacts from the scene page.
  const v = await page(viv.token, 'Viv');
  await v.evaluate((id) => openScene(id), tavern.id);
  await v.click('.audience-poll button:text-is("The docks")');
  await v.waitForSelector('.audience-poll:has-text("✔ The docks: 1")');
  await obs.waitForSelector('#poll:has-text("The docks: 1")');
  await v.click('button[aria-label="React 🔥"]');
  await obs.waitForSelector('#reactions span:has-text("🔥")');

  // Cameras: cinematic 3D, then a title card hides the scene, then back.
  await g.selectOption('.stream-panel select[name=camera]', 'cinematic');
  await obs.waitForSelector('#stage canvas', { timeout: 15000 });
  await g.click('.stream-panel button:text-is("Be right back")');
  await obs.waitForSelector('#card:not([hidden]):has-text("Be right back")');
  const duringCard = await obs.evaluate(() => document.getElementById('stage').textContent + getComputedStyle(document.getElementById('card')).display);
  await g.click('.stream-panel button:text-is("Back to the scene")');
  await obs.waitForSelector('#card[hidden]', { state: 'attached' });
  await g.click('button:text-is("Take Crypt")');
  await obs.waitForSelector('#stage:has-text("not shown on stream")');
  await g.click('button:text-is("Take Market")');
  await obs.waitForSelector('#sub:has-text("Market")');
  await g.click('.stream-panel button:text-is("Mark highlight")');
  await g.waitForSelector('summary:has-text("Highlights (1)")');
  const obsAll = await obs.content();

  // Private controls stay private.
  const notes = await g.inputValue('textarea[aria-label="GM notes"]');
  const leaked = ['Hidden goblin', 'spy', 'Herald reveals the news', 'Choose scenes', 'Crypt'].filter((x) => obsAll.includes(x));

  // 3D editing: the GM adds a wall and a trigger by clicking the tactical view, and erases the wall again.
  await g.evaluate((id) => { state.director = null; return openScene(id); }, tavern.id);
  await g.click('button:text-is("3D tactical")');
  await g.waitForSelector('#board canvas', { timeout: 15000 });
  await g.waitForTimeout(500);
  const canvas = await g.locator('#board canvas').boundingBox();
  const clickFloor = async (fx, fy) => { await g.mouse.click(canvas.x + canvas.width * fx, canvas.y + canvas.height * fy); await g.waitForTimeout(400); };
  await g.click('button:text-is("Draw walls")');
  await clickFloor(0.5, 0.55);
  let scene = await api('GET', `/api/scenes/${tavern.id}`, null, gm.token);
  const wallsAfterAdd = scene.scene.walls.length;
  await g.fill('#trigform input[name=name]', 'Lever');
  await g.click('button:text-is("Place trigger")');
  await clickFloor(0.35, 0.5);
  scene = await api('GET', `/api/scenes/${tavern.id}`, null, gm.token);
  const triggers = scene.triggers.length;
  await g.click('button:text-is("Erase walls")');
  await clickFloor(0.5, 0.55);
  scene = await api('GET', `/api/scenes/${tavern.id}`, null, gm.token);
  const wallsAfterErase = scene.scene.walls.length;

  const result = { obsBoard, obsLower, obsBrand, obsParty, hasHpBar: !!hpBar, duringCard, leaked, notes, wallsAfterAdd, triggers, wallsAfterErase, errs };
  const ok = /Herald/.test(obsBoard) && !/goblin/i.test(obsBoard) && /Herald's News/.test(obsLower) && /Dice Tower/.test(obsBrand) && /Brann/.test(obsParty) && !!hpBar
    && !/Herald/.test(duringCard) && /grid/.test(duringCard) && !leaked.length && /spy/.test(notes)
    && wallsAfterAdd === 1 && triggers === 1 && wallsAfterErase === 0 && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL', result);
  await b.close();
  process.exit(ok ? 0 : 1);
})();
