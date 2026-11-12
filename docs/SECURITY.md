# Security and privacy review (Milestone 13)

Scope: the Node server (all 122 API routes and the three live streams), the browser pages, PostgreSQL storage, the
livestream page, and the optional LiveKit server. Reviewed against the master prompt's rules: server-enforced
permissions, no hidden-information leakage, secure defaults.

## How the app is protected

| Area | Control | Evidence |
| --- | --- | --- |
| Sign-in | Email + password accounts. Passwords hashed with scrypt (N=16384, 16-byte salt); unknown emails cost the same time as wrong passwords. Display-name "quick sign-in" exists for development only and is **off when `NODE_ENV=production`** (unless `DEV_SIGNIN=1`); old development tokens stop working there too. | `test/accounts.test.js` |
| Sessions | Random 256-bit bearer tokens, stored only as SHA-256 hashes; expire after 30 days; sign out, sign out everywhere; changing the password ends other sessions. Bearer header, no cookies, so no CSRF surface. | `test/accounts.test.js` |
| Tokens in URLs | Live streams (EventSource cannot send headers) take a 10-minute stream ticket, never the session token. The browser asks for a new ticket when one expires. | `test/accounts.test.js`; browser check: no request URL contains the session token |
| Authorization | Every route checks role (GM / player / spectator / outsider) on the server. An automated sweep calls **every route** as an outsider and every write route as a spectator against a world full of secrets: nothing succeeds, nothing secret is returned, stored data does not change; every non-public route answers 401 without a session. Removing any permission check makes it fail (checked on three routes). | `test/security.test.js` |
| Hidden information | Per-viewer server projections for scenes, fog, tokens, rolls, chat, wiki, quests, adventures, NPCs, factions, and the livestream (built as a spectator, overlays included). | `test/broadcast.test.js`, `test/presentation.test.js`, `test/slice.test.js` and the milestone tests |
| Browser hardening | Content-Security-Policy: scripts only from this server plus the exact inline scripts by hash; no framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`); `nosniff`; `Referrer-Policy: no-referrer` (keeps broadcast keys and IDs out of referrers); camera/microphone only for this origin. The app builds all DOM with text nodes (no `innerHTML`, no `eval`). | `test/accounts.test.js` (headers, every inline script hashed); browser runs with no CSP violations |
| Abuse limits | Per-address limit on every API request (600/min, `RATE_LIMIT_PER_MINUTE`); sign-in 10 tries per 15 min per address and per email; sign-ups 20/hour per address (`SIGNUPS_PER_HOUR`); chat and reactions rate-limited; request bodies capped at 64 KB; list sizes and string lengths validated. Set `TRUST_PROXY=1` behind a reverse proxy so limits use the client address. | `test/accounts.test.js`, `test/chat.test.js` |
| Static files | Only `.html`/`.js` from `public/` by base name (no path traversal); browser libraries from a fixed whitelist. | code review |
| Livestream | Secret key per campaign, stored hashed, shown once, rotatable, stoppable at once (queued delayed frames dropped). Party panel only for characters whose **player** opted in. Polls show counts, never voters; reactions anonymous. | `test/presentation.test.js` |
| Data at rest | Secrets never leave the server (`tokenHash`, `keyHash`, `passwordHash` stripped from every response). Append-only logs for events, revisions, rolls, chat, XP ledger and world changes. | `test/accounts.test.js` |

## Privacy

- **What is stored about a person:** display name, email and password hash (if they made an account), session hashes,
  memberships, characters they own, chat messages and rolls they made, and an audit log of actions with their user id.
- **Export:** "Account → Download my data" (`GET /api/account/export`) returns all of it as JSON.
- **Deletion:** "Account → Delete my account" removes name, email, password, sessions and memberships. Characters stay in
  their campaigns as "Former player" so the GM's records remain whole, and stop appearing on livestreams. GMs must delete
  or hand over their worlds first. Past chat messages keep the name they were sent under (the GM can delete messages);
  the audit log keeps the user id, not the name.
- **Livestream consent:** a character appears on stream only after its player ticks the box on the sheet; the GM cannot.
  Player video and voice are never sent to the stream.
- **Third-party content:** portraits, map images and branding images are loaded from the URLs people paste, so those
  servers see the viewer's IP address. Tell beta users; host images yourself when that matters.

## Fixed during this review

- Display-name sign-in was the only sign-in, with tokens that never expired → real accounts and expiring sessions.
- Session tokens travelled in stream URLs (and so in proxy logs) → stream tickets.
- No security headers or CSP → added; inline scripts allowed by hash only.
- No request rate limit outside chat → per-address limits on every request and on sign-in.
- No way for a person to export or delete their data → added.
- No password recovery → operator tool `scripts/set-password.js` (no email service yet).

## Remaining risks (accepted for a closed beta)

- **No email verification or self-service password reset.** An operator resets passwords with
  `DATABASE_URL=… node scripts/set-password.js <email>`.
- **Session tokens live in `localStorage`.** CSP and the text-only DOM make script injection hard, but a successful
  injection could read them. Moving to `HttpOnly` cookies would then need CSRF protection.
- **Live streams are not capped per user.** Opening many streams is limited only by the request rate limit.
- **Invites do not expire** and an unused one cannot be revoked (they are single-use and 72-bit random).
- **Broadcast keys sit in the OBS page URL** (fragment, so not sent to the server on page load, but sent as a query
  parameter to the stream endpoint and visible in its access logs). Rotate the key if it leaks.
- **One process per database** (see ARCHITECTURE §11): rate limits and stream tickets are in memory, per process.
- **LiveKit** must run behind TLS with its own secret; the app mints short-lived room tokens (see DEPLOY.md).
- The 2024 SRD content needs checking against the SRD 5.2.1 PDF for three data points (see MILESTONES.md); not a
  security issue.

## Operator checklist

1. `NODE_ENV=production`, `DATABASE_URL`, HTTPS in front (Caddy/nginx), `TRUST_PROXY=1` behind it.
2. Leave `DEV_SIGNIN` unset.
3. Daily backups (`scripts/backup.js`, see OPERATIONS.md) and a tested restore.
4. LiveKit with TLS and a strong `LIVEKIT_API_SECRET`, if voice/video is offered.
5. Keep `npm audit` clean; the server has three runtime dependencies (`pg`, `livekit-client`, `three`).
