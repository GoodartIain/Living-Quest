#!/usr/bin/env node
// Milestone 10 acceptance, run by hand through the real UI: the GM writes a side-quest adventure, offers it in downtime;
// a player books and plays it alone; the GM decides the queued outcomes and publishes; the campaign changes.
// Then the GM places an interaction trigger and the player uses it.
//   PORT=3926 npm start
//   BASE_URL=http://localhost:3926 node scripts/acceptance-m10.js
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3926';
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();
(async () => {
  const gm = await api('POST', '/api/users', { name: 'GM' });
  const world = await api('POST', '/api/worlds', { name: 'Aster', advancement: 'xp', npcAutonomy: 'reactive' }, gm.token);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven' }, gm.token);
  const pat = await api('POST', '/api/users', { name: 'Pat' });
  await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, { role: 'player' }, gm.token)).code}/accept`, {}, pat.token);
  const brann = (await api('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat.token)).character;
  const place = (parent, name, extra = {}) => api('POST', `/api/locations/${parent}/children`, { name, x: 10 + name.length, y: 20, visibility: 'party', ...extra }, gm.token);
  const town = await place(world.rootLocationId, 'Greyhaven');
  const docks = await place(town.id, 'Docks');
  const cave = await place(town.id, 'Cave', { requiresDiscovery: true });
  await api('POST', `/api/worlds/${world.id}/npcs`, { name: 'Harbourmaster', homeLocationId: town.id, visibility: 'party',
    schedule: [{ from: '00:00', locationId: docks.id, activity: 'Keeping watch' }], reactions: [{ on: 'raid', activity: 'Hiding in the office', locationId: 'stay', minutes: 600 }] }, gm.token);

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

  // GM writes the adventure: start → (Stealth DC 2) → found | caught.
  await g.click('button:text-is("quests")');
  await g.click('button:text-is("New adventure")');
  const ed = g.locator('.adv-editor');
  await ed.locator('input[name=title]').fill('The missing ledger');
  await ed.locator('input[name=maxGp]').fill('20');
  const node = (i) => ed.locator('.adv-node').nth(i);
  await node(0).locator('textarea[name=text]').fill('At dusk you reach the warehouse.');
  await node(0).locator('button:text-is("+ choice")').click();
  await node(0).locator('input[name=label]').fill('Sneak in');
  await node(0).locator('input[name=check]').fill('skill:Stealth');
  await node(0).locator('input[name=dc]').fill('2');
  await node(0).locator('input[name=success]').fill('found');
  await node(0).locator('input[name=failure]').fill('caught');
  await ed.locator('button:text-is("Add node")').click();
  await node(1).locator('input[name=key]').fill('found');
  await node(1).locator('textarea[name=text]').fill('The ledger is on the desk; a tunnel leads to a cave.');
  for (let i = 0; i < 4; i++) await node(1).locator('button:text-is("+ effect")').click();
  const eff = (i) => node(1).locator('.adv-effect').nth(i);
  await eff(0).locator('input[name=amount]').fill('10');
  await eff(1).locator('select[name=type]').selectOption('item'); await eff(1).locator('input[name=value]').fill('Smuggler\'s ledger'); await eff(1).locator('input[name=major]').check();
  await g.waitForFunction(() => document.querySelectorAll('.adv-effect select[name=locationId] option').length > 4); // places load
  await eff(2).locator('select[name=type]').selectOption('discover'); await eff(2).locator('select[name=locationId]').selectOption({ label: 'Greyhaven › Cave' });
  await eff(3).locator('select[name=type]').selectOption('event'); await eff(3).locator('input[name=value]').fill('raid'); await eff(3).locator('select[name=locationId]').selectOption({ label: 'Greyhaven › Docks' });
  await ed.locator('button:text-is("Add node")').click();
  await node(2).locator('input[name=key]').fill('caught');
  await node(2).locator('textarea[name=text]').fill('A guard catches you.');
  await node(2).locator('select[name=outcome]').selectOption('failure');
  await ed.locator('button:text-is("Save adventure")').click();
  await g.waitForSelector('li:has-text("The missing ledger · 3 nodes")');

  // GM opens two weeks of downtime offering it.
  await g.click('button:text-is("‹ Aster")'); await g.click('button:text-is("downtime")');
  await g.selectOption('select[name=adventureId]', { label: 'The missing ledger' });
  await g.fill('input[name=customDays]', '3');
  await g.fill('input[name=duration]', '2');
  await g.click('button:text-is("Open downtime")');
  await g.waitForSelector('h2:has-text("(14 days)")');

  // Pat books and plays it alone.
  await p.click('button:text-is("downtime")');
  await p.selectOption('select[name=activity]', { label: 'The missing ledger · 3 d' });
  await p.click('button:text-is("Book")');
  await p.click('button:text-is("Play side quest")');
  await p.waitForSelector('.run-node:has-text("At dusk")');
  const before = await p.textContent('.run-panel');
  await p.click('.run-panel button:text-is("Sneak in (Stealth check)")');
  await p.waitForSelector('.run-panel:has-text("Finished: success")');
  const played = await p.textContent('.run-panel');

  // GM reviews: approve the ledger and the raid; publish.
  await g.click('button:text-is("‹ Aster")'); await g.click('button:text-is("downtime")');
  await g.click('button:text-is("Review side quest")');
  const outcome = (txt) => g.locator('.run-panel li.effect', { hasText: txt });
  await outcome('Item: Smuggler\'s ledger').locator('button:text-is("approve")').click();
  await g.waitForSelector('.run-panel li.effect.approved:has-text("Smuggler")');
  await outcome('World event').locator('button:text-is("approve")').click();
  await g.waitForSelector('li.dt-action:has-text("Brann: The missing ledger") >> text=approved');
  await g.click('button:text-is("Publish results")');
  await g.waitForSelector('h2:has-text("Downtime reports")');
  const report = await g.locator('details').last().textContent();

  const sheet = await api('GET', `/api/characters/${brann.id}`, null, pat.token);
  const caveSeen = (await fetch(`${B}/api/locations/${cave.id}`, { headers: { authorization: `Bearer ${pat.token}` } })).status;
  const log = await api('GET', `/api/campaigns/${camp.id}/npc-log`, null, gm.token);

  // Trigger: the GM places an alarm bell; Pat stands next to it and rings it.
  const scene = await api('POST', `/api/locations/${docks.id}/scenes`, { name: 'Quay', visibility: 'party', cols: 8, rows: 6 }, gm.token);
  const me = (await api('GET', `/api/worlds/${world.id}`, null, gm.token)).members.find((m) => m.name === 'Pat').userId;
  await api('POST', `/api/scenes/${scene.id}/tokens`, { name: 'x', x: 2, y: 2, characterId: brann.id, controlledBy: [me] }, gm.token);
  await g.evaluate((id) => openScene(id), scene.id);
  await g.fill('#trigform input[name=name]', 'Alarm bell');
  await g.fill('#trigform textarea[name=text]', 'The bell clangs across the quay.');
  await g.fill('#trigform input[name=event]', 'raid');
  await g.click('button:text-is("Place trigger")');
  const box = await g.locator('svg.board').boundingBox();
  await g.mouse.click(box.x + box.width * (3.5 / 8), box.y + box.height * (2.5 / 6));
  await p.evaluate((id) => openScene(id), scene.id);
  await p.waitForSelector('svg.board .trig');
  await p.click('svg.board .trig');
  await p.waitForSelector('#trigout:has-text("The bell clangs")');
  const rang = await p.textContent('#trigout');

  const result = { before: before.slice(0, 120), played: played.slice(0, 300), report, gp: sheet.character.currency.gp, items: sheet.character.inventory.map((i) => i.name), caveSeen, rang, errs };
  const ok = !/ledger is on the desk/.test(before) && /applies on publish/.test(played) && /needs GM approval|waiting for the GM/.test(played)
    && sheet.character.currency.gp >= 10 && result.items.includes('Smuggler\'s ledger') && caveSeen === 200
    && log.some((x) => x.kind === 'reacted' && /Harbourmaster/.test(x.text)) && /Discover Cave/.test(report) && /bell clangs/.test(rang) && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL', result);
  await b.close();
  process.exit(ok ? 0 : 1);
})();
