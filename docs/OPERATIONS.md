# Running Living Quest (operations guide)

## Deploy (one server, Docker)

Needs: a Linux server with Docker, two DNS names pointing at it (the app and voice), ports 80 and 443 open, plus
7881/tcp and 50000–50100/udp for voice and video.

```sh
git clone https://github.com/GoodartIain/Living-Quest.git && cd Living-Quest
cp .env.example .env            # fill in every CHANGE value: domains, passwords, LiveKit secret, public IP
docker compose up -d            # db, LiveKit, app, Caddy (HTTPS), daily backups
docker compose ps               # app shows "healthy" once /healthz answers
```

Caddy gets HTTPS certificates for `APP_DOMAIN` and `VOICE_DOMAIN` automatically. The app runs with `NODE_ENV=production`:
only email + password accounts (no name-only sign-in), real client addresses for rate limits (`TRUST_PROXY=1`).

Local trial on one computer: `docker compose -f docker-compose.yml -f docker-compose.local.yml up`, then
http://localhost:3000 (quick name-only sign-in is on, no HTTPS needed on localhost).

Without Docker: Node 22, PostgreSQL 14+, a TLS reverse proxy (Caddy/nginx) and optionally LiveKit
(see DEPLOY.md); `NODE_ENV=production DATABASE_URL=… TRUST_PROXY=1 npm start`.

## Upgrade

```sh
git pull && docker compose up -d --build
```

Database changes are versioned migrations (`migrations/NNN_*.sql`) applied automatically, once, on start. The app stops
gracefully on `docker compose` restarts (SIGTERM: live streams end and reconnect, the last change is written). **Take a
backup before every upgrade** (below). Downgrading is not supported: restore the backup instead.

## Backups and restore

The `backup` service writes a consistent backup every day to `./backups/lq-YYYY-MM-DD.json` (private file mode) and keeps
`BACKUP_KEEP_DAYS` (default 14) days. **Copy the backups off the server** (e.g. `rclone`, `restic`, or your provider's
object storage); they contain password hashes and every world's secrets, so store them encrypted.

By hand: `docker compose run --rm backup node scripts/backup.js /backups/before-upgrade.json`
(or `DATABASE_URL=… node scripts/backup.js file.json` without Docker). It is safe while the app is running.

Restore (into a new, empty database; the script refuses anything else, and refuses backups from a newer version):

```sh
docker compose stop app
docker compose exec db createdb -U livingquest livingquest_restored
docker compose run --rm -e DATABASE_URL=postgres://livingquest:$POSTGRES_PASSWORD@db:5432/livingquest_restored \
  backup node scripts/restore.js /backups/lq-2026-11-12.json
# point the app at it: set DATABASE_URL in docker-compose.yml (…/livingquest_restored), then
docker compose up -d app
```

**Practise a restore before the beta starts** and after any big upgrade. `test/backup.test.js` checks that a restored
database equals the original exactly; your own drill checks the procedure and the off-server copies.

PostgreSQL's own tools (`pg_dump -Fc`, point-in-time recovery) work too, and are better for very large databases.

## Monitoring

- `GET /healthz` → `200 {"ok":true}` when the app and database respond, `503` otherwise. Point an uptime monitor at
  `https://APP_DOMAIN/healthz`. Docker marks the container unhealthy after three failures.
- Logs: `docker compose logs -f app`. The app logs start-up, shutdown, storage write failures and unexpected errors
  (never request bodies or passwords). Unexpected errors answer the browser with "internal error" only.
- Audit trail: every consequential change is in the `events` table (actor, type, data, time).
- Capacity: see PERFORMANCE.md. One app process per database.

## Common tasks

- **A player forgot their password** (no email service yet):
  `docker compose run --rm backup node scripts/set-password.js player@example.org` and type the new one; tell them
  privately. Their other sessions end.
- **A broadcast link leaked:** Director Mode → Livestream → "Make a new link" (the old one stops at once), or
  "Stop streaming now".
- **Someone misbehaves in chat:** the GM deletes messages; remove them from the campaign by deleting the account (they
  can do it themselves under Account) or, as operator, `DELETE` their sessions (`DELETE FROM sessions WHERE user_id=…`).
- **Rate limits too tight for a group behind one address** (school, club): raise `SIGNUPS_PER_HOUR` or
  `RATE_LIMIT_PER_MINUTE` in `.env`.

## Checks before every release

`npm test` with `TEST_DATABASE_URL` (and `LIVEKIT_TEST_URL`) must pass; CI (`.github/workflows/ci.yml`) also runs the
browser acceptance scripts, the 2D/3D compatibility check, the accessibility audit and a short load test.
