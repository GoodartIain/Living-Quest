#!/usr/bin/env node
// Milestone 8 acceptance, run by hand through the real UI: the GM opens three in-game weeks of downtime, two players
// book activities on their own, both claim the same forge, the GM decides and publishes once.
//   PORT=3926 npm start
//   BASE_URL=http://localhost:3926 node scripts/acceptance-m8.js
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3926';
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();
const hero = (name) => ({ name, species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
  baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] });
(async () => {
  const gm = await api('POST', '/api/users', { name: 'GM' });
  const world = await api('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm.token);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven' }, gm.token);
  const players = [];
  for (const [user, name] of [['Pat', 'Brann'], ['Ana', 'Mira']]) {
    const u = await api('POST', '/api/users', { name: user });
    await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, { role: 'player' }, gm.token)).code}/accept`, {}, u.token);
    const c = await api('POST', `/api/campaigns/${camp.id}/characters`, hero(name), u.token);
    await api('PATCH', `/api/characters/${c.character.id}`, { currency: { gp: 20 } }, gm.token);
    players.push({ ...u, char: c.character });
  }
  const b = await chromium.launch();
  const errs = [];
  const open = async (token, who) => {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
    await ctx.addInitScript((tok) => localStorage.setItem('lq-token', tok), token);
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`${who}: ${e.message}`));
    pg.on('dialog', (d) => d.accept());
    await pg.goto(B); await pg.click('li >> button:text-is("Aster")');
    await pg.click('button:text-is("downtime")');
    await pg.waitForSelector('h2:has-text("Today:")');
    return pg;
  };
  const [g, p1, p2] = [await open(gm.token, 'GM'), await open(players[0].token, 'Pat'), await open(players[1].token, 'Ana')];

  // GM: three weeks, default activities plus a paid custom one.
  await g.fill('input[name=customName]', 'Rent the master forge');
  await g.fill('input[name=customDays]', '4'); await g.fill('input[name=customCost]', '5'); await g.fill('input[name=customItem]', 'Masterwork blade');
  await g.click('button:text-is("Open downtime")');
  await g.waitForSelector('h2:has-text("(21 days)")');

  const book = async (pg, activity, day, claim = '') => {
    await pg.click('button:text-is("‹ Aster")'); await pg.click('button:text-is("downtime")'); // reload to see the new window
    await pg.waitForSelector('select[name=activity]');
    await pg.selectOption('select[name=activity]', { label: activity });
    await pg.fill('input[name=day]', String(day)); await pg.fill('input[name=claim]', claim);
    await pg.click('button:text-is("Book")');
  };
  await book(p1, 'Training · 10 d', 1);
  await p1.waitForSelector('li.dt-action:has-text("Training")');
  await book(p1, 'Working a trade · 7 d · automatic', 5); // overlaps training: refused
  const refused = await p1.waitForFunction(() => document.getElementById('err').textContent, null, { timeout: 5000 }).then((x) => x.jsonValue()).catch(() => '');
  await book(p1, 'Working a trade · 7 d · automatic', 11);
  await p1.waitForSelector('li.dt-action:has-text("Working a trade") >> text=approved');
  await book(p1, 'Rent the master forge · 4 d · 5 gp', 18, 'master forge');
  await book(p2, 'Rent the master forge · 4 d · 5 gp', 1, 'Master Forge');
  await p2.waitForSelector('li.dt-action:has-text("conflict")');
  const p2Sees = await p2.$$eval('li.dt-action strong', (s) => s.map((x) => x.textContent));

  // GM: approve training with XP, give the forge to Mira, publish.
  await g.click('button:text-is("‹ Aster")'); await g.click('button:text-is("downtime")');
  await g.waitForSelector('li.dt-action:has-text("Brann: Training")');
  const row = (txt) => g.locator('li.dt-action', { hasText: txt });
  await row('Brann: Training').locator('input[name=rewardXp]').fill('100');
  await row('Brann: Training').locator('button:text-is("Approve")').click();
  await g.waitForSelector('li.dt-action:has-text("Brann: Training") >> text=approved');
  await row('Mira: Rent the master forge').locator('input[name=rewardItem]').fill('Masterwork blade');
  await row('Mira: Rent the master forge').locator('button:text-is("Approve")').click();
  await g.waitForSelector('li.dt-action:has-text("Brann: Rent the master forge") >> text=rejected');
  await g.click('button:text-is("Publish results")');
  await g.waitForSelector('h2:has-text("Downtime reports")');
  const today = await g.textContent('h2:has-text("Today:")');

  const brann = await api('GET', `/api/characters/${players[0].char.id}`, null, gm.token);
  const mira = await api('GET', `/api/characters/${players[1].char.id}`, null, gm.token);
  await p1.click('button:text-is("‹ Aster")'); await p1.click('button:text-is("downtime")');
  await p1.waitForSelector('h2:has-text("Downtime reports")');
  const p1Report = await p1.textContent('details');
  const result = { refused, p2Sees, today, brann: [brann.xp, brann.character.currency.gp], mira: [mira.character.currency.gp, mira.character.inventory.map((i) => i.name)], p1Report, errs };
  const ok = /busy with Training/.test(refused) && p2Sees.every((s) => s.startsWith('Mira')) && /22 Month 1/.test(today)
    && brann.xp === 100 && brann.character.currency.gp === 27 && mira.character.currency.gp === 15
    && mira.character.inventory.filter((i) => i.name === 'Masterwork blade').length === 1 && !/Mira/.test(p1Report) && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL', result);
  await b.close();
  process.exit(ok ? 0 : 1);
})();
