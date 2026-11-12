#!/usr/bin/env node
// Consistent logical backup of a Living Quest database to one JSON file (safe while the app is running).
//   DATABASE_URL=postgres://… node scripts/backup.js backups/lq-$(date +%F).json
// With KEEP_DAYS=14, daily backups (lq-YYYY-MM-DD.json) older than 14 days in that folder are removed afterwards.
// The file holds passwords and session hashes and every world's secrets: store it encrypted and private.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { snapshot } = require('../store.js');

(async () => {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error('usage: DATABASE_URL=… node scripts/backup.js <file.json>'); process.exit(2); }
  const { migrations, data } = await snapshot(process.env.DATABASE_URL);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.partial`;
  fs.writeFileSync(tmp, JSON.stringify({ format: 'living-quest-backup', version: 1, takenAt: new Date().toISOString(), migrations, data }), { mode: 0o600 });
  fs.renameSync(tmp, file); // never leave a half-written backup under the real name
  // Optional retention: with KEEP_DAYS, older daily backups (files named lq-YYYY-MM-DD.json in the same folder) are pruned.
  const keep = Number(process.env.KEEP_DAYS);
  if (keep > 0) {
    const dir = path.dirname(path.resolve(file));
    for (const name of fs.readdirSync(dir).filter((n) => /^lq-\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
      const full = path.join(dir, name);
      if (full !== path.resolve(file) && Date.now() - fs.statSync(full).mtimeMs > keep * 864e5) fs.unlinkSync(full);
    }
  }
  const rows = Object.values(data).reduce((n, t) => n + t.length, 0);
  console.error(`Backed up ${rows} rows (${Object.keys(data).length} tables, schema ${migrations.at(-1)}) to ${file}`);
})().catch((e) => { console.error(`backup failed: ${e.message}`); process.exit(1); });
