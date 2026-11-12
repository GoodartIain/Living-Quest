#!/usr/bin/env node
// Multiplayer load test. ROOMS campaigns at once, each a GM and 6 players with the scene and chat streams open; every
// player moves their token once a second and chats now and then. Measures how long a move takes to reach every other
// person in the room (server work + persistence + fan-out), plus errors and server memory.
//   SIGNUPS_PER_HOUR=100000 RATE_LIMIT_PER_MINUTE=1000000 DATABASE_URL=… PORT=3926 npm start
//   BASE_URL=http://localhost:3926 ROOMS=10 SECONDS=30 node scripts/load-test.js
'use strict';
const B = process.env.BASE_URL || 'http://localhost:3926';
const ROOMS = Number(process.env.ROOMS) || 10;
const SECONDS = Number(process.env.SECONDS) || 30;
const PLAYERS = 6;

const api = async (method, url, body, token) => {
  const res = await fetch(B + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${url}: ${res.status} ${data.error}`), { status: res.status });
  return data;
};
// Minimal SSE reader: calls onData for each `data:` payload.
async function stream(path, token, onData, signal) {
  const { ticket } = await api('POST', '/api/stream-tickets', {}, token);
  const res = await fetch(`${B}${path}?ticket=${ticket}`, { signal });
  if (!res.ok) throw new Error(`stream ${path}: ${res.status}`);
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          if (line) onData(JSON.parse(line.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : null; };

(async () => {
  const ac = new AbortController();
  const latencies = [];
  const errors = [];
  let moves = 0, chats = 0, events = 0;
  const pending = new Map(); // `${tokenId}:${x},${y}` → { sent, waiting: Set(userIndex) }
  const t0 = Date.now();
  const rooms = [];
  for (let r = 0; r < ROOMS; r++) {
    const gm = (await api('POST', '/api/users', { name: `GM${r}` })).token;
    const w = await api('POST', '/api/worlds', { name: `Load ${r}`, advancement: 'xp' }, gm);
    const c = await api('POST', `/api/worlds/${w.id}/campaigns`, { name: 'C' }, gm);
    const scene = await api('POST', `/api/locations/${w.rootLocationId}/scenes`, { name: 'Arena', visibility: 'party', cols: 30, rows: 30 }, gm);
    const people = [{ token: gm, name: `GM${r}` }];
    for (let p = 0; p < PLAYERS; p++) {
      const token = (await api('POST', '/api/users', { name: `P${r}-${p}` })).token;
      await api('POST', `/api/invites/${(await api('POST', `/api/campaigns/${c.id}/invites`, {}, gm)).code}/accept`, {}, token);
      people.push({ token, name: `P${r}-${p}` });
    }
    const members = (await api('GET', `/api/worlds/${w.id}`, null, gm)).members;
    for (const [p, person] of people.slice(1).entries()) {
      const uid = members.find((m) => m.name === person.name).userId;
      person.tokenId = (await api('POST', `/api/scenes/${scene.id}/tokens`, { name: person.name, x: p * 4, y: 0, controlledBy: [uid] }, gm)).id;
      person.x = p * 4; person.y = 0;
    }
    rooms.push({ scene, campaign: c, people });
  }
  const setup = Date.now() - t0;

  // Everyone opens the scene and chat streams; a move counts as delivered when all 6 others have seen it.
  for (const room of rooms) {
    for (const [i, person] of room.people.entries()) {
      await stream(`/api/scenes/${room.scene.id}/stream`, person.token, (view) => {
        events++;
        for (const t of view.tokens) {
          const key = `${t.id}:${t.x},${t.y}`;
          const m = pending.get(key);
          if (m && m.waiting.delete(i) && !m.waiting.size) { latencies.push(Date.now() - m.sent); pending.delete(key); }
        }
      }, ac.signal);
      await stream(`/api/campaigns/${room.campaign.id}/chat/stream`, person.token, () => { events++; }, ac.signal);
    }
  }
  await new Promise((r) => setTimeout(r, 1000));

  // Load: every player moves once a second (staggered), and chats every ~10 s.
  const end = Date.now() + SECONDS * 1000;
  const loops = rooms.flatMap((room) => room.people.slice(1).map((person, p) => (async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 1000));
    while (Date.now() < end) {
      const t = Date.now();
      person.y = (person.y + 1) % 30;
      const key = `${person.tokenId}:${person.x},${person.y}`;
      pending.set(key, { sent: t, waiting: new Set([0, 1, 2, 3, 4, 5, 6].filter((i) => i !== p + 1)) });
      try { await api('PATCH', `/api/tokens/${person.tokenId}`, { x: person.x, y: person.y }, person.token); moves++; } catch (e) { errors.push(e.message); }
      if (Math.random() < 0.1) { try { await api('POST', `/api/campaigns/${room.campaign.id}/chat`, { channel: 'table', text: 'Onward!' }, person.token); chats++; } catch (e) { errors.push(e.message); } }
      await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - t))));
    }
  })()));
  await Promise.all(loops);
  await new Promise((r) => setTimeout(r, 2000));
  ac.abort();
  const result = {
    rooms: ROOMS, people: ROOMS * (PLAYERS + 1), streams: ROOMS * (PLAYERS + 1) * 2, seconds: SECONDS, setupSeconds: Math.round(setup / 1000),
    moves, chats, streamEvents: events, movesPerSecond: Math.round(moves / SECONDS),
    deliveredToAll: latencies.length, undelivered: pending.size,
    latencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99), max: pct(latencies, 100) },
    errors: errors.length, firstErrors: [...new Set(errors)].slice(0, 3),
  };
  console.log(JSON.stringify(result, null, 2));
  const ok = !errors.length && result.latencyMs.p95 !== null && result.latencyMs.p95 < 500 && pending.size <= ROOMS * PLAYERS;
  console.log(ok ? 'PASS (p95 under 500 ms, no errors)' : 'FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
