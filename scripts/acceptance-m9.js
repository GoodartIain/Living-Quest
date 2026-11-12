#!/usr/bin/env node
// Milestone 9 acceptance, run by hand through the real UI: the GM builds a merchant's routine in the NPC editor; a player
// watches the market scene while the GM moves the clock; a fire makes her flee and move her stall to the docks.
//   PORT=3926 npm start
//   BASE_URL=http://localhost:3926 node scripts/acceptance-m9.js
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3926';
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();
(async () => {
  const gm = await api('POST', '/api/users', { name: 'GM' });
  const world = await api('POST', '/api/worlds', { name: 'Aster', advancement: 'xp', npcAutonomy: 'reactive' }, gm.token);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven' }, gm.token);
  const pat = await api('POST', '/api/users', { name: 'Pat' });
  await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, { role: 'player' }, gm.token)).code}/accept`, {}, pat.token);
  const place = (parent, name) => api('POST', `/api/locations/${parent}/children`, { name, x: 10 + name.length, y: 20, visibility: 'party' }, gm.token);
  const town = await place(world.rootLocationId, 'Greyhaven');
  const [house, market, tavern, docks] = [await place(town.id, 'House'), await place(town.id, 'Market'), await place(town.id, 'Tavern'), await place(town.id, 'Docks')];
  const square = await api('POST', `/api/locations/${market.id}/scenes`, { name: 'Market square', visibility: 'party', cols: 10, rows: 8 }, gm.token);
  await api('POST', `/api/worlds/${world.id}/pages`, { title: 'Mara the spice merchant', kind: 'npc', visibility: 'party' }, gm.token);

  const b = await chromium.launch();
  const errs = [];
  const open = async (token, who) => {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 1000 } });
    await ctx.addInitScript((tok) => localStorage.setItem('lq-token', tok), token);
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    pg.on('dialog', (d) => d.accept());
    await pg.goto(B); await pg.click('li >> button:text-is("Aster")');
    return pg;
  };
  const g = await open(gm.token, 'GM');
  const p = await open(pat.token, 'Pat');

  // GM: build Mara in the editor.
  await g.click('button:text-is("NPCs")');
  await g.click('button:text-is("New NPC")');
  const ed = g.locator('.npc-editor');
  await ed.locator('input[name=name]').fill('Mara');
  await ed.locator('select[name=pageId]').selectOption({ label: 'Mara the spice merchant' });
  await ed.locator('input[name=occupation]').fill('spice merchant');
  await ed.locator('select[name=homeLocationId]').selectOption({ label: 'Greyhaven › House' });
  const steps = [['07:00', 'Market', 'Selling spices', true], ['12:00', 'Tavern', 'Eating lunch'], ['13:00', 'Market', 'Selling spices', true], ['21:00', 'House', 'Sleeping']];
  for (const [i, [from, where, what, onScene]] of steps.entries()) {
    await ed.locator('button:text-is("Add step")').click();
    const row = ed.locator('.npc-step').nth(i);
    await row.locator('input[name=from]').fill(from);
    await row.locator('select[name=locationId]').selectOption({ label: `Greyhaven › ${where}` });
    await row.locator('input[name=activity]').fill(what);
    if (onScene) { await row.locator('select[name=sceneId]').selectOption({ label: 'Market square (10×8)' }); await row.locator('input[name=x]').fill('3'); await row.locator('input[name=y]').fill('4'); }
  }
  await ed.locator('button:text-is("Add reaction")').click();
  const r = ed.locator('.npc-react');
  await r.locator('input[name=on]').fill('fire');
  await r.locator('input[name=activity]').fill('Hiding at home');
  await r.locator('select[name=locationId]').selectOption({ label: 'home' });
  await r.locator('input[name=minutes]').fill('120');
  await r.locator('select[name=then]').selectOption('relocate');
  await r.locator('select[name=from]').selectOption({ label: 'Greyhaven › Market' });
  await r.locator('select[name=to]').selectOption({ label: 'Greyhaven › Docks' });
  await ed.locator('button:text-is("Save NPC")').click();
  const row = () => g.textContent('tr.npc-row');
  await g.waitForSelector('tr.npc-row:has-text("Selling spices at Market")');

  // Player: Mara is at the market and on its scene.
  await p.evaluate((id) => go(id), market.id);
  const hereMarket = await p.textContent('.npcs-here');
  await p.evaluate((id) => openScene(id), square.id);
  const onBoard = (name, yes) => p.waitForFunction(([n, y]) => [...document.querySelectorAll('svg.board text')].some((t) => t.textContent === n) === y, [name, yes], { timeout: 8000 });
  await onBoard('Mara', true);

  // Lunch: the GM moves the clock; the player's board updates live.
  await g.click('button:text-is("+4 hours")');
  await g.waitForSelector('tr.npc-row:has-text("Eating lunch at Tavern")');
  await onBoard('Mara', false);
  await g.click('button:text-is("+1 hour")');
  await g.waitForSelector('tr.npc-row:has-text("Selling spices at Market")');
  await onBoard('Mara', true);

  // Fire in Greyhaven: she flees home, then trades from the docks.
  await g.fill('input[name=kind]', 'fire');
  await g.selectOption('select[name=locationId] >> nth=0', { label: 'Greyhaven' });
  await g.fill('input[name=note]', 'the spice warehouse burns');
  await g.click('button:text-is("Trigger")');
  await g.waitForSelector('tr.npc-row:has-text("Hiding at home at House")');
  const fleeing = await row();
  await onBoard('Mara', false);
  await g.fill('input[name=until]', '16:00'); await g.click('button:text-is("Go")');
  await g.waitForSelector('tr.npc-row:has-text("Selling spices at Docks")');
  const history = await g.textContent('.npc-log');

  await p.evaluate((id) => go(id), docks.id);
  const hereDocks = await p.textContent('.npcs-here');
  const result = { hereMarket, fleeing, hereDocks, history: history.slice(0, 400), errs };
  const ok = /Mara \(selling spices\)/.test(hereMarket) && /until 15:00, fire/.test(fleeing) && /Mara \(selling spices\)/.test(hereDocks)
    && /now works at Docks instead of Market/.test(history) && /resumes the routine/.test(history) && /Event: fire at Greyhaven/.test(history) && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL', result);
  await b.close();
  process.exit(ok ? 0 : 1);
})();
