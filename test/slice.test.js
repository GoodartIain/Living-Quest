// Vertical slice: world → campaign → advancement → town → location → map + wiki → invite → navigate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server.js');

async function boot(file) {
  const server = http.createServer(createApp({ file }).handle);
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const ok = async (...a) => {
    const r = await call(...a);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  return { server, call, ok };
}

test('vertical slice with server-enforced visibility', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lq-')), 'data.json');
  const { server, call, ok } = await boot(file);
  t.after(() => server.close());

  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const player = (await ok('POST', '/api/users', { name: 'Pat' })).token;
  const viewer = (await ok('POST', '/api/users', { name: 'Viv' })).token;

  assert.equal((await call('POST', '/api/worlds', { name: 'X', advancement: 'levels' }, gm)).status, 400);
  const world = await ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp', npcAutonomy: 'scheduled' }, gm);
  assert.equal(world.settings.advancement, 'xp');

  const campaign = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Three Weeks' }, gm);
  assert.deepEqual(campaign.advancement, { mode: 'xp', source: 'world' });
  // Switching mode needs explicit confirmation.
  assert.equal((await call('PATCH', `/api/campaigns/${campaign.id}/advancement`, { mode: 'milestone' }, gm)).status, 409);
  const switched = await ok('PATCH', `/api/campaigns/${campaign.id}/advancement`, { mode: 'milestone', confirm: true }, gm);
  assert.deepEqual(switched.advancement, { mode: 'milestone', source: 'campaign' });

  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`,
    { name: 'Greyhaven', type: 'town', x: 40, y: 60, visibility: 'public' }, gm);
  const tavern = await ok('POST', `/api/locations/${town.id}/children`,
    { name: 'Gilded Gull', type: 'tavern', x: 20, y: 30, visibility: 'party' }, gm);
  await ok('POST', `/api/locations/${town.id}/children`, { name: 'Smugglers Den', type: 'hideout', x: 70, y: 70, visibility: 'gm' }, gm);
  await ok('PATCH', `/api/maps/${town.mapId}`, { imageUrl: 'https://example.com/greyhaven.png' }, gm);
  await ok('PATCH', `/api/pages/${tavern.pageId}`, { body: 'Run by Mara.', gmNotes: 'Mara is a spy.' }, gm);
  assert.equal((await call('PATCH', `/api/maps/${town.mapId}`, { imageUrl: 'javascript:alert(1)' }, gm)).status, 400);

  // Not a member yet: the world does not exist for them.
  assert.equal((await call('GET', `/api/locations/${town.id}`, null, player)).status, 404);

  const inv = await ok('POST', `/api/campaigns/${campaign.id}/invites`, { role: 'player' }, gm);
  await ok('POST', `/api/invites/${inv.code}/accept`, {}, player);
  assert.equal((await call('POST', `/api/invites/${inv.code}/accept`, {}, viewer)).status, 410);
  const sInv = await ok('POST', `/api/campaigns/${campaign.id}/invites`, { role: 'spectator' }, gm);
  await ok('POST', `/api/invites/${sInv.code}/accept`, {}, viewer);

  // Player navigates world map → town → tavern.
  const me = await ok('GET', '/api/me', null, player);
  assert.deepEqual(me.worlds.map((w) => w.role), ['player']);
  const root = await ok('GET', `/api/locations/${world.rootLocationId}`, null, player);
  assert.deepEqual(root.children.map((c) => c.name), ['Greyhaven']);
  const townView = await ok('GET', `/api/locations/${town.id}`, null, player);
  assert.equal(townView.map.imageUrl, 'https://example.com/greyhaven.png');
  assert.deepEqual(townView.children.map((c) => c.name), ['Gilded Gull'], 'GM-only hideout must not reach players');
  const tavernView = await ok('GET', `/api/locations/${tavern.id}`, null, player);
  assert.deepEqual(tavernView.breadcrumbs.map((b) => b.name), ['Aster', 'Greyhaven', 'Gilded Gull']);
  assert.equal(tavernView.page.body, 'Run by Mara.');
  assert.equal(tavernView.page.gmNotes, undefined);

  // Spectator sees less than a player; players cannot edit.
  assert.deepEqual((await ok('GET', `/api/locations/${town.id}`, null, viewer)).children, []);
  assert.equal((await call('GET', `/api/locations/${tavern.id}`, null, viewer)).status, 404);
  assert.equal((await call('PATCH', `/api/pages/${tavern.pageId}`, { body: 'x' }, player)).status, 403);
  assert.equal((await call('POST', `/api/locations/${town.id}/children`, { name: 'Y', x: 1, y: 1 }, player)).status, 403);

  // Rename keeps every link (stable ids); GM still sees notes.
  await ok('PATCH', `/api/locations/${town.id}`, { name: 'Greyhaven Port' }, gm);
  const gmTavern = await ok('GET', `/api/locations/${tavern.id}`, null, gm);
  assert.equal(gmTavern.breadcrumbs[1].name, 'Greyhaven Port');
  assert.equal(gmTavern.page.gmNotes, 'Mara is a spy.');

  // State survives a restart, including the append-only event log.
  const again = createApp({ file });
  assert.equal(again.db.locations.length, 4);
  assert.ok(again.db.events.some((e) => e.type === 'campaign.advancement.changed'));
  assert.ok(!JSON.stringify((await call('GET', '/api/me', null, gm)).body).includes('tokenHash'));
});

test('milestone 2: inhabitants, links, backlinks, search, history, discovery', async (t) => {
  const { server, call, ok } = await boot();
  t.after(() => server.close());
  const gm = (await ok('POST', '/api/users', { name: 'Gm' })).token;
  const player = (await ok('POST', '/api/users', { name: 'Pat' })).token;
  const viewer = (await ok('POST', '/api/users', { name: 'Viv' })).token;
  const world = await ok('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C1' }, gm);
  const other = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C2' }, gm);
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, player);
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role: 'spectator' }, gm)).code}/accept`, {}, viewer);

  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', type: 'town', x: 40, y: 60, visibility: 'public' }, gm);
  const tavern = await ok('POST', `/api/locations/${town.id}/children`, { name: 'Gilded Gull', type: 'tavern', x: 20, y: 30 }, gm);
  const crypt = await ok('POST', `/api/locations/${town.id}/children`, { name: 'Old Crypt', type: 'dungeon', x: 80, y: 80, requiresDiscovery: true }, gm);
  const vault = await ok('POST', `/api/locations/${crypt.id}/children`, { name: 'Vault', x: 50, y: 50 }, gm);

  // Inhabitants are wiki entities joined to the tavern by relationships.
  const mara = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'Mara', kind: 'npc', body: 'Keeps the [[Gilded Gull]]. Fears the [[Old Crypt]].', gmNotes: 'Spy for [[Black Hand]].' }, gm);
  const hand = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'Black Hand', kind: 'faction', visibility: 'gm' }, gm);
  const cook = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'Hob', kind: 'npc', visibility: 'gm' }, gm);
  await ok('POST', `/api/worlds/${world.id}/relationships`, { fromId: mara.id, toId: tavern.pageId, kind: 'runs' }, gm);
  await ok('POST', `/api/worlds/${world.id}/relationships`, { fromId: cook.id, toId: tavern.pageId, kind: 'works at' }, gm);
  await ok('POST', `/api/worlds/${world.id}/relationships`, { fromId: mara.id, toId: hand.id, kind: 'member of', visibility: 'party' }, gm);
  assert.equal((await call('POST', `/api/worlds/${world.id}/relationships`, { fromId: mara.id, toId: mara.id, kind: 'x' }, gm)).status, 400);
  assert.ok(mara.body.includes(`[[${tavern.pageId}]]`), '[[Title]] is stored as [[id]]');
  // [[Black Hand]] was written before that page existed, so it stays as typed.
  assert.ok(mara.gmNotes.includes('[[Black Hand]]'));

  // Acceptance: player goes world map → town → tavern and sees only authorised inhabitants.
  const root = await ok('GET', `/api/locations/${world.rootLocationId}`, null, player);
  const townView = await ok('GET', `/api/locations/${root.children[0].id}`, null, player);
  assert.deepEqual(townView.children.map((c) => c.name), ['Gilded Gull'], 'undiscovered crypt stays off the map');
  const tavernView = await ok('GET', `/api/locations/${tavern.id}`, null, player);
  assert.deepEqual(tavernView.relationships.map((r) => [r.other.title, r.kind]), [['Mara', 'runs']]);
  const maraView = await ok('GET', `/api/pages/${mara.id}`, null, player);
  assert.equal(maraView.page.body, `Keeps the [[${tavern.pageId}|Gilded Gull]]. Fears the [unknown].`);
  assert.equal(maraView.page.gmNotes, undefined);
  assert.deepEqual(maraView.relationships.map((r) => r.other.title), ['Gilded Gull'], 'relationship to a GM-only faction is hidden');
  assert.equal((await call('GET', `/api/pages/${hand.id}`, null, player)).status, 404);
  assert.deepEqual(tavernView.backlinks.map((b) => b.title), ['Mara']);
  assert.equal((await call('GET', `/api/pages/${mara.id}`, null, viewer)).status, 404, 'party pages are not public');

  // Discovery is per campaign, hides the whole subtree, and never applies to the GM.
  assert.equal((await call('GET', `/api/locations/${vault.id}`, null, player)).status, 404);
  await ok('PUT', `/api/locations/${crypt.id}/discovery`, { campaignId: other.id, discovered: true }, gm);
  assert.equal((await call('GET', `/api/locations/${crypt.id}`, null, player)).status, 404, 'another campaign found it, not ours');
  await ok('PUT', `/api/locations/${crypt.id}/discovery`, { campaignId: camp.id, discovered: true }, gm);
  assert.equal((await ok('GET', `/api/locations/${vault.id}`, null, player)).breadcrumbs.length, 4);
  assert.equal((await ok('GET', `/api/pages/${mara.id}`, null, player)).page.body,
    `Keeps the [[${tavern.pageId}|Gilded Gull]]. Fears the [[${crypt.pageId}|Old Crypt]].`);
  assert.deepEqual((await ok('GET', `/api/locations/${crypt.id}`, null, gm)).location.discoveredIn.sort(), [camp.id, other.id].sort());

  // Search respects visibility and never searches GM notes for players.
  const titles = async (q, tok) => (await ok('GET', `/api/worlds/${world.id}/pages?q=${encodeURIComponent(q)}`, null, tok)).map((p) => p.title);
  assert.deepEqual(await titles('spy', gm), ['Mara']);
  assert.deepEqual(await titles('spy', player), []);
  assert.deepEqual(await titles('hob', player), []);
  assert.ok((await titles('', player)).includes('Mara'));

  // History keeps every prior version; renames keep links and backlinks.
  await ok('PATCH', `/api/pages/${mara.id}`, { body: 'Moved on.' }, gm);
  const hist = await ok('GET', `/api/pages/${mara.id}/history`, null, gm);
  assert.ok(hist[0].body.startsWith('Keeps the'));
  assert.equal((await call('GET', `/api/pages/${mara.id}/history`, null, player)).status, 403);
  await ok('PATCH', `/api/pages/${mara.id}`, { body: hist[0].body }, gm); // restore = save the old version
  await ok('PATCH', `/api/locations/${tavern.id}`, { name: 'Salty Gull' }, gm);
  assert.ok((await ok('GET', `/api/pages/${mara.id}`, null, player)).page.body.includes('|Salty Gull]]'));
  assert.equal((await ok('GET', `/api/pages/${tavern.pageId}`, null, gm)).page.title, 'Salty Gull');
});

test('markdown parser yields data, not HTML', () => {
  const { parseMarkdown } = require('../public/markdown.js');
  assert.deepEqual(parseMarkdown('# Hi\n\nA **[[x|Y]]** *i* <script>\n- one\n- two'), [
    { tag: 'h3', inline: ['Hi'] },
    { tag: 'p', inline: ['A ', { b: [{ link: 'x', text: 'Y' }] }, ' ', { i: ['i'] }, ' <script>'] },
    { tag: 'ul', items: [['one'], ['two']] },
  ]);
});
