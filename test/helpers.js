// Shared test harness: boots the app on a free port and returns small HTTP/SSE clients.
const assert = require('node:assert/strict');
const http = require('node:http');
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
  // Opens a scene's event stream; `until(fn)` resolves with the first message (old or new) that fn accepts.
  async function listen(sceneId, token) {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/scenes/${sceneId}/stream?token=${token}`, { signal: ac.signal });
    const msgs = [];
    let wake = () => {};
    if (res.ok) (async () => {
      let buf = '';
      const dec = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
            const block = buf.slice(0, i);
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (data) msgs.push({ event: (block.match(/^event: (.*)$/m) || [])[1] || 'message', data: JSON.parse(data.slice(6)) });
          }
          wake();
        }
      } catch { /* aborted */ }
    })();
    const until = (fn, ms = 2000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no matching stream message')), ms);
      (wake = () => { const m = msgs.find(fn); if (m) { clearTimeout(timer); resolve(m); } })();
    });
    return { status: res.status, msgs, until, close: () => ac.abort() };
  }
  return { server, call, ok, listen };
}

module.exports = { boot };
