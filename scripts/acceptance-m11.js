#!/usr/bin/env node
// Milestone 11 acceptance, run by hand through the real UI: the GM sets up a faction and a scheduled arrival, previews
// two in-world weeks, decides the major developments, commits; the committed world matches the preview; the player
// sees the faction's attitude and the rumours.
//   PORT=3926 npm start
//   BASE_URL=http://localhost:3926 node scripts/acceptance-m11.js
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
  const [market, docks, mill] = [await place(town.id, 'Market'), await place(town.id, 'Docks'), await place(town.id, 'Old mill')];
  const road = await place(world.rootLocationId, 'Road');
  await api('POST', `/api/worlds/${world.id}/npcs`, { name: 'Harbourmaster', homeLocationId: docks.id, visibility: 'party',
    schedule: [{ from: '00:00', locationId: docks.id, activity: 'Keeping watch' }], reactions: [{ on: 'smuggling', activity: 'Counting crates', locationId: 'stay', minutes: 120 }] }, gm.token);
  await api('POST', `/api/worlds/${world.id}/npcs`, { name: 'Jory', homeLocationId: road.id, visibility: 'party', autonomy: 'scheduled', schedule: [{ from: '00:00', locationId: road.id, activity: 'Travelling' }] }, gm.token);

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
  await g.click('button:text-is("world")');

  // The guild, built in the editor: recruits weekly (costs 20) and talks up prices every 5 days.
  await g.click('button:text-is("New faction")');
  const fe = g.locator('.faction-editor');
  await fe.locator('input[name=name]').fill('Merchant Guild');
  await fe.locator('input[name=influence]').fill('40');
  await fe.locator('input[name=resources]').fill('30');
  await fe.locator('input[data-standing=party]').fill('10');
  await fe.locator('button:text-is("Add activity")').click();
  const act = (i) => fe.locator('.w-activity').nth(i);
  await act(0).locator('input[name=aname]').fill('Recruit');
  await act(0).locator('input[name=cost]').fill('20');
  await fe.locator('button:text-is("Add activity")').click();
  await act(1).locator('input[name=aname]').fill('Talk up prices');
  await act(1).locator('input[name=every]').fill('5');
  await act(1).locator('select[name=sig]').selectOption('routine');
  await act(1).locator('select[name=kind]').selectOption('rumour');
  await act(1).locator('input[name=text]').fill('The guild says prices will fall.');
  await fe.locator('button:text-is("Save faction")').click();
  await g.waitForSelector('table.factions td:has-text("Merchant Guild")');
  const guild = (await api('GET', `/api/campaigns/${camp.id}/world`, null, gm.token)).factions[0];
  // A rival made through the API to keep the script short: smuggling runs and a grab for the mill.
  await api('POST', `/api/worlds/${world.id}/factions`, { name: 'Black Sail', visibility: 'gm', influence: 30, resources: 30, standings: { [guild.id]: -20 }, activities: [
    { name: 'Smuggling run', every: 4, cost: 10, effects: [{ kind: 'resources', delta: 25 }, { kind: 'event', eventKind: 'smuggling', locationId: docks.id }] },
    { name: 'Seize the old mill', every: 14, effects: [{ kind: 'territory', locationId: mill.id }] }] }, gm.token);
  await g.click('button:text-is("‹ Aster")'); await g.click('button:text-is("world")');

  // The travelling merchant's arrival, scheduled in the form.
  const hf = g.locator('section:has(h2:text-is("Scheduled happenings")) form');
  await hf.locator('input[name=inDays]').fill('9');
  await hf.locator('input[name=label]').fill('Jory reaches Greyhaven');
  await hf.locator('select[name=kind]').selectOption('npc');
  await hf.locator('select[name=npcId]').selectOption({ label: 'Jory' });
  await hf.locator('select[name=locationId]').selectOption({ label: 'Market' });
  await hf.locator('input[name=activity]').fill('Selling exotic wares');
  await hf.locator('input[name=hours]').fill('120');
  await hf.locator('button:text-is("Schedule")').click();
  await g.waitForSelector('li:has-text("Jory reaches Greyhaven")');

  // Preview two weeks: decide the majors (reject the mill grab), then commit.
  await g.fill('.sim input[name=days]', '14');
  await g.click('.sim button:text-is("Preview")');
  await g.waitForSelector('.sim h3:has-text("Draft")');
  const undecidedBefore = await g.locator('li.dev.undecided').count();
  const commitDisabled = await g.locator('button.commit').isDisabled();
  await g.locator('li.dev.undecided:has-text("Seize the old mill") button:text-is("reject")').click();
  await g.waitForSelector('li.dev.rejected:has-text("Seize the old mill")');
  while (await g.locator('li.dev.undecided').count()) {
    await g.locator('li.dev.undecided button:text-is("approve")').first().click();
    await g.waitForTimeout(300);
  }
  const draft = await g.evaluate(() => worldUi.preview);
  const skipped = draft.developments.filter((d) => d.status === 'skipped').map((d) => d.source);
  await g.click('button.commit');
  await g.waitForSelector('h2:has-text("Now:")');
  await g.waitForFunction(() => !document.querySelector('.sim h3'));
  const w = await api('GET', `/api/campaigns/${camp.id}/world`, null, gm.token);
  const match = draft.factions.every((f) => { const cur = w.factions.find((x) => x.name === f.name).current; return cur.influence === f.influence && cur.resources === f.resources; });
  const npcs = await api('GET', `/api/worlds/${world.id}/npcs`, null, gm.token);
  const jory = npcs.npcs.find((n) => n.name === 'Jory').now;
  const history = await g.textContent('.world-history');

  // The player.
  const p = await open(pat.token, 'Pat');
  await p.click('button:text-is("world")');
  await p.waitForSelector('h2:text-is("Factions")');
  const playerView = await p.textContent('#app');
  const result = { undecidedBefore, commitDisabled, skipped, match, now: w.now, to: draft.to, jory, history: history.slice(0, 300), playerView: playerView.slice(0, 400), errs };
  const ok = undecidedBefore >= 1 && commitDisabled && skipped.includes('Merchant Guild: Recruit') && match && w.now === draft.to
    && jory.place === 'Market' && /Black Sail: Smuggling run/.test(history) && /Merchant Guild/.test(playerView) && /prices will fall/.test(playerView)
    && !/Black Sail/.test(playerView) && !w.factions.find((f) => f.name === 'Black Sail').current.territory.includes(mill.id) && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL', result);
  await b.close();
  process.exit(ok ? 0 : 1);
})();
