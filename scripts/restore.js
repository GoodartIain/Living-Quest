#!/usr/bin/env node
// Restore a backup made by scripts/backup.js into a new, empty database (it refuses anything else).
//   createdb livingquest_restored
//   DATABASE_URL=postgres://…/livingquest_restored node scripts/restore.js backups/lq-2026-11-12.json
// Then point the app's DATABASE_URL at the restored database.
'use strict';
const fs = require('node:fs');
const { restoreInto } = require('../store.js');

(async () => {
  const file = process.argv[2];
  if (!file || !process.env.DATABASE_URL) { console.error('usage: DATABASE_URL=… node scripts/restore.js <backup.json>'); process.exit(2); }
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (backup.format !== 'living-quest-backup') throw new Error('not a Living Quest backup file');
  const counts = await restoreInto(process.env.DATABASE_URL, backup);
  console.error(`Restored backup from ${backup.takenAt}: ${Object.entries(counts).filter(([, n]) => n).map(([c, n]) => `${c} ${n}`).join(', ')}`);
})().catch((e) => { console.error(`restore failed: ${e.message}`); process.exit(1); });
