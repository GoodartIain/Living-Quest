#!/usr/bin/env node
// Accessibility audit (Milestone 13): runs axe-core (WCAG 2.1 A/AA rules) on every main screen as the GM, a player and a
// spectator, plus the livestream page, and lists every violation. Exit code 1 if any serious or critical issue remains.
//   PORT=3926 npm start
//   BASE_URL=http://localhost:3926 node scripts/a11y-audit.js
const fs = require('node:fs');
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3926';
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();

(async () => {
  // A small world with something on every screen.
  const gm = (await api('POST', '/api/users', { name: 'GM' })).token;
  const world = await api('POST', '/api/worlds', { name: 'Audit', advancement: 'xp', npcAutonomy: 'reactive' }, gm);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const pat = (await api('POST', '/api/users', { name: 'Pat' })).token;
  await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, pat);
  const viv = (await api('POST', '/api/users', { name: 'Viv' })).token;
  await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${camp.id}/invites`, { role: 'spectator' }, gm)).code}/accept`, {}, viv);
  const ch = (await api('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat)).character;
  const town = await api('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 30, y: 30, visibility: 'public' }, gm);
  const page = await api('POST', `/api/worlds/${world.id}/pages`, { title: 'Mara', kind: 'npc', visibility: 'public', body: 'Innkeeper of [[Greyhaven]].' }, gm);
  const scene = await api('POST', `/api/locations/${town.id}/scenes`, { name: 'Square', visibility: 'public' }, gm);
  await api('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Brann', x: 1, y: 1, characterId: ch.id }, gm);
  await api('POST', `/api/scenes/${scene.id}/triggers`, { name: 'Lever', x: 3, y: 3, visibility: 'public' }, gm);
  await api('POST', `/api/worlds/${world.id}/npcs`, { name: 'Mara', homeLocationId: town.id, schedule: [{ from: '00:00', locationId: town.id, activity: 'Serving' }] }, gm);
  await api('POST', `/api/worlds/${world.id}/factions`, { name: 'Guild', visibility: 'public' }, gm);
  await api('POST', `/api/campaigns/${camp.id}/quests`, { title: 'Find the ledger', objectives: [{ text: 'Search' }] }, gm);
  const dt = await api('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 2, unit: 'weeks' }, gm);
  await api('POST', `/api/downtime/${dt.id}/actions`, { characterId: ch.id, activity: 'training', startDay: dt.startDay }, pat);
  const bc = await api('PATCH', `/api/campaigns/${camp.id}/broadcast`, { enabled: true, sceneId: scene.id, lowerThird: 'Live' }, gm);
  await api('POST', `/api/campaigns/${camp.id}/poll`, { question: 'Where next?', options: ['North', 'South'] }, gm);

  const screens = [
    ['sign-in', null, async () => {}],
    ['world list', gm, async () => {}],
    ['world map', gm, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.world && state.loc); }],
    ['town and inhabitants (player)', pat, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.evaluate((id) => go(id), town.id); await p.waitForSelector('h2:has-text("Greyhaven")'); }],
    ['wiki page', pat, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.evaluate((id) => openPage(id), page.id); await p.waitForTimeout(300); }],
    ['character sheet (player)', pat, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.evaluate((id) => openCharacter(id), ch.id); await p.waitForSelector('h3:has-text("Hit points")'); }],
    ['character creation', pat, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.click('button:text-is("Create a character")'); await p.waitForTimeout(300); }],
    ['scene 2D (GM)', gm, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.evaluate((id) => openScene(id), scene.id); await p.waitForSelector('svg.board'); }],
    ['scene 2D (spectator)', viv, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.evaluate((id) => openScene(id), scene.id); await p.waitForSelector('svg.board'); await p.waitForTimeout(500); }],
    ['chat panel', pat, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForSelector('#chat-toggle:not([hidden])'); await p.click('#chat-toggle'); await p.waitForTimeout(300); }],
    ['director', gm, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.click('button:text-is("director")'); await p.waitForSelector('.stream-preview'); }],
    ['downtime (GM)', gm, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.click('button:text-is("downtime")'); await p.waitForSelector('li.dt-action'); }],
    ['downtime (player)', pat, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.click('button:text-is("downtime")'); await p.waitForSelector('li.dt-action'); }],
    ['NPCs', gm, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.click('button:text-is("NPCs")'); await p.waitForSelector('tr.npc-row'); await p.click('button:text-is("edit")'); await p.waitForSelector('.npc-editor'); }],
    ['quests and adventures', gm, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.click('button:text-is("quests")'); await p.waitForSelector('text=Quest log'); await p.click('button:text-is("New adventure")'); await p.waitForSelector('.adv-editor'); }],
    ['world simulation', gm, async (p) => { await p.click('li >> button:text-is("Audit")'); await p.waitForFunction(() => state.loc); await p.click('button:text-is("world")'); await p.waitForSelector('.sim'); await p.click('.sim button:text-is("Preview")'); await p.waitForSelector('.sim h3'); }],
    ['account', pat, async (p) => { await p.click('#account-btn'); await p.waitForSelector('text=Your account'); }],
    ['livestream page', null, async (p) => { await p.goto(`${B}/broadcast.html#key=${bc.key}`); await p.waitForSelector('#stage svg'); }],
  ];
  const b = await chromium.launch();
  const report = [];
  for (const [name, token, open] of screens) {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, bypassCSP: true }); // only so the audit library can be injected
    if (token) await ctx.addInitScript((x) => localStorage.setItem('lq-token', x), token);
    const p = await ctx.newPage();
    await p.goto(B);
    await p.waitForTimeout(300);
    await open(p);
    await p.addScriptTag({ content: AXE });
    const r = await p.evaluate(async () => (await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
      .map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length, sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ')) })));
    report.push({ screen: name, violations: r });
    await ctx.close();
  }
  await b.close();
  let serious = 0;
  for (const { screen, violations } of report) {
    console.log(`${violations.length ? '✗' : '✓'} ${screen}${violations.length ? '' : ': no violations'}`);
    for (const v of violations) {
      if (['serious', 'critical'].includes(v.impact)) serious++;
      console.log(`    [${v.impact}] ${v.id} ×${v.count}: ${v.help} — ${v.sample.join(' | ')}`);
    }
  }
  console.log(serious ? `FAIL: ${serious} serious or critical issue type(s)` : 'PASS: no serious or critical issues');
  process.exit(serious ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
