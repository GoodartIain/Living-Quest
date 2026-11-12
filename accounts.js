// Milestone 13: accounts and sessions. Email + password (scrypt), sessions that expire, logout, short-lived stream
// tickets so session tokens never travel in URLs, rate limits, and the user's own data export and account deletion.
// The original display-name sign-in stays for development and demos, and is off when NODE_ENV=production unless
// DEV_SIGNIN=1. Accounts made that way can add an email and password later.
'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const TICKET_MS = 10 * 60 * 1000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function checkPassword(pw, stored) {
  const [kind, n, salt, key] = String(stored || '').split('$');
  // Unknown users still pay for one hash, so response time does not reveal which emails exist.
  const expect = kind === 'scrypt' ? Buffer.from(key, 'base64') : Buffer.alloc(64);
  const got = await scrypt(pw, kind === 'scrypt' ? Buffer.from(salt, 'base64') : Buffer.alloc(16), 64, { N: Number(n) || 16384, r: 8, p: 1 });
  return kind === 'scrypt' && crypto.timingSafeEqual(got, expect);
}

// Fixed-window counters: { key → { n, until } }.
function limiter(max, windowMs) {
  const seen = new Map();
  return (key) => {
    const now = Date.now();
    if (seen.size > 50000) for (const [k, v] of seen) if (v.until < now) seen.delete(k); // keep memory bounded
    const s = seen.get(key);
    if (!s || s.until < now) { seen.set(key, { n: 1, until: now + windowMs }); return true; }
    s.n++;
    return s.n <= max;
  };
}

module.exports = function accounts({ db, find, fail, record, id, check, hash, env }) {
  const { str } = check;
  const devSignIn = env.NODE_ENV !== 'production' || env.DEV_SIGNIN === '1';
  const tickets = new Map(); // ticket → { userId, until } (memory only: a restart just makes clients fetch a new one)
  const loginLimit = limiter(10, 15 * 60 * 1000);   // per IP and per email
  const signupLimit = limiter(Number(env.SIGNUPS_PER_HOUR) || 20, 60 * 60 * 1000); // per IP (a household or school shares one)
  const requestLimit = limiter(Number(env.RATE_LIMIT_PER_MINUTE) || 600, 60 * 1000); // per IP, every API request

  function newSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions.push({ id: id(), userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() });
    return token;
  }
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email || null, hasPassword: !!u.passwordHash });
  const email = (v) => { const e = str(v, 'email', 254).toLowerCase(); if (!EMAIL.test(e)) fail(400, 'that does not look like an email address'); return e; };
  const password = (v) => { if (typeof v !== 'string' || v.length < 10 || v.length > 200) fail(400, 'password must be 10 to 200 characters'); return v; };

  // Bearer token (header) or stream ticket (query). Session tokens are never accepted in URLs.
  function authenticate(req, ticket) {
    if (ticket !== undefined) {
      const t = ticket && tickets.get(ticket);
      if (!t || t.until < Date.now()) fail(401, 'stream ticket expired');
      return find('users', t.userId);
    }
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const h = token && hash(token);
    if (!h) fail(401, 'sign in first');
    const s = db.sessions.find((x) => x.tokenHash === h);
    if (s) {
      if (Date.parse(s.expiresAt) < Date.now()) fail(401, 'your session has expired; sign in again');
      return find('users', s.userId);
    }
    // Development tokens from before Milestone 13 (display-name accounts) keep working only where dev sign-in is allowed.
    const legacy = devSignIn && db.users.find((u) => u.tokenHash === h);
    return legacy || fail(401, 'sign in first');
  }
  const ipOf = (req) => (env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress) || '?';
  function throttle(req) { if (!requestLimit(ipOf(req))) fail(429, 'too many requests; slow down'); }

  const routes = {
    'GET /api/auth/config': () => ({ devSignIn, passwordMin: 10 }),
    // Development sign-in: a display name, no password.
    'POST /api/users': (_u, b, _p, req) => {
      if (!devSignIn) fail(403, 'create an account with an email and password');
      if (!signupLimit(`dev:${ipOf(req)}`)) fail(429, 'too many sign-ups from here; try later');
      const user = { id: id(), name: str(b.name, 'name', 60), tokenHash: null, email: null, passwordHash: null };
      db.users.push(user);
      record(user.id, 'user.created', { userId: user.id, method: 'dev' });
      return { user: publicUser(user), token: newSession(user) };
    },
    'POST /api/auth/register': async (_u, b, _p, req) => {
      if (!signupLimit(ipOf(req))) fail(429, 'too many sign-ups from here; try later');
      const e = email(b.email);
      const pw = password(b.password);
      const name = str(b.name, 'name', 60);
      if (db.users.some((u) => u.email === e)) fail(409, 'an account with that email already exists; sign in instead');
      const user = { id: id(), name, tokenHash: null, email: e, passwordHash: await hashPassword(pw) };
      db.users.push(user);
      record(user.id, 'user.created', { userId: user.id, method: 'password' });
      return { user: publicUser(user), token: newSession(user) };
    },
    'POST /api/auth/login': async (_u, b, _p, req) => {
      const e = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      if (!loginLimit(`ip:${ipOf(req)}`) || !loginLimit(`email:${e}`)) fail(429, 'too many attempts; wait 15 minutes');
      const user = db.users.find((u) => u.email && u.email === e);
      const ok = await checkPassword(typeof b.password === 'string' ? b.password.slice(0, 200) : '', user && user.passwordHash);
      if (!user || !ok) fail(401, 'wrong email or password');
      record(user.id, 'user.login', { userId: user.id });
      return { user: publicUser(user), token: newSession(user) };
    },
    'POST /api/auth/logout': (u, _b, _p, req) => {
      const h = hash((req.headers.authorization || '').replace(/^Bearer /, ''));
      db.sessions = db.sessions.filter((s) => s.tokenHash !== h);
      record(u.id, 'user.logout', { userId: u.id });
      return { ok: true };
    },
    'POST /api/auth/logout-everywhere': (u) => {
      db.sessions = db.sessions.filter((s) => s.userId !== u.id);
      for (const [k, t] of tickets) if (t.userId === u.id) tickets.delete(k);
      record(u.id, 'user.logout', { userId: u.id, everywhere: true });
      return { ok: true };
    },
    // For live streams (EventSource cannot send headers): valid for 10 minutes, then the page asks for another.
    'POST /api/stream-tickets': (u) => {
      const ticket = crypto.randomBytes(24).toString('base64url');
      const now = Date.now();
      for (const [k, t] of tickets) if (t.until < now) tickets.delete(k);
      tickets.set(ticket, { userId: u.id, until: now + TICKET_MS });
      return { ticket, expiresInSeconds: TICKET_MS / 1000 };
    },
    'GET /api/account': (u) => publicUser(u),
    // Add or change email and password: { name?, email?, password?, currentPassword }
    'PATCH /api/account': async (u, b) => {
      if (u.passwordHash && !(await checkPassword(typeof b.currentPassword === 'string' ? b.currentPassword : '', u.passwordHash))) fail(403, 'current password is wrong');
      if (b.name !== undefined) u.name = str(b.name, 'name', 60);
      if (b.email !== undefined) {
        const e = email(b.email);
        if (db.users.some((x) => x.id !== u.id && x.email === e)) fail(409, 'that email is used by another account');
        u.email = e;
      }
      if (b.password !== undefined) {
        u.passwordHash = await hashPassword(password(b.password));
        u.tokenHash = null; // retire any development token
        db.sessions = db.sessions.filter((s) => s.userId !== u.id); // other devices must sign in again
      }
      if (u.email && !u.passwordHash) fail(400, 'set a password too');
      record(u.id, 'user.updated', { userId: u.id, fields: Object.keys(b).filter((k) => k !== 'password' && k !== 'currentPassword') });
      return { user: publicUser(u), ...(b.password !== undefined && { token: newSession(u) }) };
    },
    // Everything stored about you as a person (not the worlds you run: export those from your worlds).
    'GET /api/account/export': (u) => ({
      exportedAt: new Date().toISOString(), account: publicUser(u),
      memberships: db.memberships.filter((m) => m.userId === u.id).map((m) => ({ ...m, campaign: find('campaigns', m.campaignId).name })),
      worldsOwned: db.worlds.filter((w) => w.ownerId === u.id).map((w) => ({ id: w.id, name: w.name })),
      characters: db.characters.filter((c) => c.ownerId === u.id),
      messagesSent: db.messages.filter((m) => m.fromUserId === u.id),
      rolls: db.rolls.filter((r) => r.userId === u.id),
      sessions: db.sessions.filter((s) => s.userId === u.id).map((s) => ({ expiresAt: s.expiresAt })),
    }),
    // Delete your account: refused while you run worlds (hand them over or delete them first). Your name is removed
    // everywhere it is shown; characters stay with the campaign under "Former player" so the GM's records stay whole.
    'DELETE /api/account': async (u, b) => {
      if (u.passwordHash && !(await checkPassword(typeof b.currentPassword === 'string' ? b.currentPassword : '', u.passwordHash))) fail(403, 'current password is wrong');
      if (db.worlds.some((w) => w.ownerId === u.id)) fail(409, 'you are the GM of a world; delete it or hand it over first');
      u.name = 'Former player'; u.email = null; u.passwordHash = null; u.tokenHash = null;
      db.sessions = db.sessions.filter((s) => s.userId !== u.id);
      db.memberships = db.memberships.filter((m) => m.userId !== u.id);
      for (const c of db.characters.filter((x) => x.ownerId === u.id)) c.onStream = false;
      for (const k of [...tickets.keys()]) if (tickets.get(k).userId === u.id) tickets.delete(k);
      record(u.id, 'user.deleted', { userId: u.id });
      return { ok: true };
    },
  };
  const anonymous = new Set(['GET /api/auth/config', 'POST /api/users', 'POST /api/auth/register', 'POST /api/auth/login']);
  return { routes, authenticate, throttle, anonymous, devSignIn };
};
module.exports.hashPassword = hashPassword;
