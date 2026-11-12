#!/usr/bin/env node
// Operator tool (no email service yet): set a user's password and end their sessions.
//   DATABASE_URL=postgres://… node scripts/set-password.js player@example.org   (then type the new password)
'use strict';
const readline = require('node:readline');
const { postgresStore } = require('../store.js');
const { hashPassword } = require('../accounts.js');

(async () => {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email || !process.env.DATABASE_URL) { console.error('usage: DATABASE_URL=… node scripts/set-password.js <email>'); process.exit(2); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const pw = await new Promise((r) => rl.question('New password (10+ characters): ', (a) => { rl.close(); r(a); }));
  if (pw.length < 10 || pw.length > 200) { console.error('password must be 10 to 200 characters'); process.exit(2); }
  const store = await postgresStore({ databaseUrl: process.env.DATABASE_URL });
  const u = store.db.users.find((x) => x.email === email);
  if (!u) { console.error(`no account with email ${email}`); await store.close(); process.exit(1); }
  u.passwordHash = await hashPassword(pw);
  u.tokenHash = null;
  store.db.sessions = store.db.sessions.filter((s) => s.userId !== u.id);
  store.db.events.push({ seq: store.db.events.length + 1, at: new Date().toISOString(), actor: u.id, type: 'user.password-reset-by-operator', data: { userId: u.id } });
  await store.persist();
  await store.close();
  console.error(`Password set for ${email}; their other sessions have ended.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
