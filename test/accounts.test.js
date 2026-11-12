// Milestone 13: accounts, sessions, stream tickets, rate limits, data export, account deletion, security headers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('accounts: register, login, sessions, tickets, export, delete', async (t) => {
  const { app, call, ok, listenTo, close } = await boot();
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return close(); });

  // Register: validation, duplicates, no secrets in replies.
  assert.equal((await call('POST', '/api/auth/register', { name: 'Gm', email: 'not-an-email', password: 'long enough pw' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { name: 'Gm', email: 'gm@example.test', password: 'short' })).status, 400);
  const reg = await ok('POST', '/api/auth/register', { name: 'Gm', email: 'GM@Example.test', password: 'correct horse battery' });
  assert.equal(reg.user.email, 'gm@example.test');
  assert.equal((await call('POST', '/api/auth/register', { name: 'X', email: 'gm@example.test', password: 'another password' })).status, 409);
  const gm = reg.token;
  const me = await ok('GET', '/api/me', null, gm);
  assert.deepEqual([me.user.name, me.user.hasPassword], ['Gm', true]);
  assert.ok(!JSON.stringify(me).includes('scrypt'));
  assert.ok(app.db.users[0].passwordHash.startsWith('scrypt$'), 'stored hashed');

  // Login.
  assert.equal((await call('POST', '/api/auth/login', { email: 'gm@example.test', password: 'wrong password!' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'nobody@example.test', password: 'wrong password!' })).status, 401);
  const second = (await ok('POST', '/api/auth/login', { email: 'gm@example.test', password: 'correct horse battery' })).token;
  await ok('GET', '/api/me', null, second);

  // Logout ends one session; an expired session is refused.
  await ok('POST', '/api/auth/logout', {}, second);
  assert.equal((await call('GET', '/api/me', null, second)).status, 401);
  const third = (await ok('POST', '/api/auth/login', { email: 'gm@example.test', password: 'correct horse battery' })).token;
  app.db.sessions.at(-1).expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await call('GET', '/api/me', null, third)).status, 401);

  // A development (display-name) account adds an email and password later; then other sessions end.
  const pat = (await ok('POST', '/api/users', { name: 'Pat' })).token;
  assert.equal((await call('PATCH', '/api/account', { email: 'pat@example.test' }, pat)).status, 400, 'an email needs a password');
  const patNew = (await ok('PATCH', '/api/account', { email: 'pat@example.test', password: 'pats own password' }, pat)).token;
  assert.equal((await call('GET', '/api/me', null, pat)).status, 401, 'the old session ended');
  await ok('GET', '/api/me', null, patNew);
  assert.equal((await call('PATCH', '/api/account', { password: 'changed password', currentPassword: 'wrong one here' }, patNew)).status, 403);
  await ok('POST', '/api/auth/login', { email: 'pat@example.test', password: 'pats own password' });

  // Streams take tickets, never session tokens in the URL.
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const scene = await ok('POST', `/api/locations/${world.rootLocationId}/scenes`, { name: 'S' }, gm);
  const viaToken = await call('GET', `/api/scenes/${scene.id}/stream?token=${gm}`);
  assert.equal(viaToken.status, 401, 'a session token in the URL is refused');
  const s = await listenTo(`/api/scenes/${scene.id}/stream`, gm); // the helper swaps the token for a ticket
  streams.push(s);
  assert.equal(s.status, 200);

  // Export your own data; delete your account (refused while you run a world).
  await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, {}, gm)).code}/accept`, {}, patNew);
  const ch = (await ok('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, patNew)).character;
  const exp = await ok('GET', '/api/account/export', null, patNew);
  assert.deepEqual([exp.account.email, exp.characters[0].name, exp.memberships.length], ['pat@example.test', 'Brann', 1]);
  assert.ok(!JSON.stringify(exp).includes('scrypt') && !JSON.stringify(exp).includes('tokenHash'));
  assert.equal((await call('DELETE', '/api/account', { currentPassword: 'correct horse battery' }, gm)).status, 409, 'the GM of a world');
  assert.equal((await call('DELETE', '/api/account', { currentPassword: 'wrong one here' }, patNew)).status, 403);
  await ok('DELETE', '/api/account', { currentPassword: 'pats own password' }, patNew);
  assert.equal((await call('GET', '/api/me', null, patNew)).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'pat@example.test', password: 'pats own password' })).status, 401);
  const members = (await ok('GET', `/api/worlds/${world.id}`, null, gm)).members;
  assert.ok(!members.some((m) => m.name === 'Pat'), 'membership removed');
  assert.equal((await ok('GET', `/api/characters/${ch.id}`, null, gm)).character.name, 'Brann', 'the campaign keeps the character');
});

test('accounts: production turns off dev sign-in and legacy tokens; limits; headers', async (t) => {
  const prod = await boot({ env: { NODE_ENV: 'production', RATE_LIMIT_PER_MINUTE: '30' } });
  t.after(prod.close);
  assert.deepEqual(await prod.ok('GET', '/api/auth/config'), { devSignIn: false, passwordMin: 10 });
  assert.equal((await prod.call('POST', '/api/users', { name: 'Dev' })).status, 403);
  // A legacy token row (from before accounts) does not work in production.
  const crypto = require('node:crypto');
  prod.app.db.users.push({ id: 'legacy', name: 'Old', tokenHash: crypto.createHash('sha256').update('oldtoken').digest('hex'), email: null, passwordHash: null });
  assert.equal((await prod.call('GET', '/api/me', null, 'oldtoken')).status, 401);
  // Login attempts are limited per email.
  await prod.ok('POST', '/api/auth/register', { name: 'A', email: 'a@example.test', password: 'a long password' });
  let last;
  for (let i = 0; i < 11; i++) last = await prod.call('POST', '/api/auth/login', { email: 'a@example.test', password: 'wrong wrong wrong' });
  assert.equal(last.status, 429);
  // Every API request is limited per address.
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++) limited = (await prod.call('GET', '/api/auth/config')).status === 429;
  assert.ok(limited);

  // Security headers on pages and API.
  const dev = await boot();
  t.after(dev.close);
  const base = `http://localhost:${dev.server.address().port}`;
  const page = await fetch(`${base}/`);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const apiRes = await fetch(`${base}/api/auth/config`);
  assert.equal(apiRes.headers.get('cache-control'), 'no-store');
  // Every inline script on every page is covered by the policy (a missing hash would break the page).
  for (const name of ['index.html', 'broadcast.html']) {
    const res = await fetch(`${base}/${name}`);
    const html = await res.text();
    const policy = res.headers.get('content-security-policy');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g))
      assert.ok(policy.includes(crypto.createHash('sha256').update(m[1]).digest('base64')), `${name} inline script allowed`);
  }
});
