#!/usr/bin/env node
// Milestone 5 acceptance, run by hand: a GM and six players join one campaign call (camera + microphone) and chat,
// then everyone moves between views. Needs Playwright with Chromium, a LiveKit server and the app running, e.g.:
//   livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1
//   PORT=3926 LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret npm start
//   BASE_URL=http://localhost:3926 node scripts/acceptance-m5.js
const { chromium } = require('playwright');
const B = process.env.BASE_URL || 'http://localhost:3926';
const api = async (method, url, body, token) => (await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) })).json();
(async () => {
  const t0 = Date.now();
  const gm = await api('POST', '/api/users', { name: 'GM' });
  const world = await api('POST', '/api/worlds', { name: 'Aster', advancement: 'xp' }, gm.token);
  const camp = await api('POST', `/api/worlds/${world.id}/campaigns`, { name: 'Greyhaven' }, gm.token);
  const town = await api('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 40, y: 40, visibility: 'party' }, gm.token);
  const scene = await api('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', visibility: 'party' }, gm.token);
  const users = [{ name: 'GM', token: gm.token }];
  for (let i = 1; i <= 6; i++) {
    const u = await api('POST', '/api/users', { name: `P${i}` });
    const inv = await api('POST', `/api/campaigns/${camp.id}/invites`, { role: 'player' }, gm.token);
    await api('POST', `/api/invites/${inv.code}/accept`, {}, u.token);
    users.push({ name: `P${i}`, token: u.token });
  }
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const errs = [];
  const pages = await Promise.all(users.map(async (u) => {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 800 } });
    await ctx.grantPermissions(['microphone', 'camera'], { origin: B });
    await ctx.addInitScript((tok) => localStorage.setItem('lq-token', tok), u.token);
    const pg = await ctx.newPage(); pg.on('pageerror', (e) => errs.push(`${u.name}: ${e.message}`));
    await pg.goto(B); await pg.click('li >> button:text-is("Aster")'); await pg.waitForSelector('#voice-toggle:not([hidden])');
    return pg;
  }));
  for (const pg of pages) { await pg.click('#voice-toggle'); await pg.click('button:text-is("Join with camera")'); }
  await Promise.all(pages.map((pg) => pg.waitForFunction(() => voice.room && voice.room.remoteParticipants.size === 6, null, { timeout: 30000 })));
  await Promise.all(pages.map((pg) => pg.waitForFunction(() => [...document.querySelectorAll('#voice .tile video')].filter((v) => v.videoWidth > 0).length === 7, null, { timeout: 45000 })));
  const audio = await Promise.all(pages.map((pg) => pg.$$eval('#voice-audio audio', (a) => a.length)));
  // Everyone moves between views mid-call: world map → town → scene → character list.
  await Promise.all(pages.map(async (pg) => {
    await pg.evaluate((id) => go(id), town.id); await pg.waitForSelector('h2:has-text("Greyhaven")');
    await pg.evaluate((id) => openScene(id), scene.id); await pg.waitForSelector('svg.board');
    await pg.evaluate(() => go(state.world.rootLocationId));
  }));
  const after = await Promise.all(pages.map((pg) => pg.evaluate(() => [voice.status, voice.room && voice.room.remoteParticipants.size])));
  // Chat while moving around: P3 whispers the GM, P1 talks to the table.
  await pages[3].click('#chat-toggle'); await pages[3].selectOption('#chat select[name=channel]', 'whisper');
  await pages[3].check('#chat label:has-text("GM") >> input'); await pages[3].fill('#chat textarea', 'I slip away.'); await pages[3].press('#chat textarea', 'Enter');
  await pages[1].click('#chat-toggle'); await pages[1].fill('#chat textarea', 'Ready!'); await pages[1].press('#chat textarea', 'Enter');
  await Promise.all(pages.map((pg) => pg.waitForFunction(() => chat.messages.some((m) => m.text === 'Ready!'), null, { timeout: 10000 })));
  const whisperSeenBy = await Promise.all(pages.map((pg) => pg.evaluate(() => chat.messages.some((m) => m.text === 'I slip away.'))));
  const ok = after.every(([s, n]) => s === 'connected' && n === 6) && audio.every((n) => n === 6) && whisperSeenBy.join() === [true, false, false, true, false, false, false].join() && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL', { seconds: Math.round((Date.now() - t0) / 1000), audioElements: audio, afterNavigation: after, whisperSeenBy, errs });
  await b.close();
  process.exit(ok ? 0 : 1);
})();
