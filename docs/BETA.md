# Public beta preparation

## Go / no-go checklist

| Item | Status |
| --- | --- |
| Full test suite on PostgreSQL with LiveKit (43 tests) | ✅ passing |
| End-to-end "Three Weeks in Greyhaven" scenario (`test/greyhaven.test.js`) | ✅ passing |
| Browser acceptance scripts, Milestones 5–12 | ✅ passing (Chromium) |
| Authorization sweep over all 122 routes; spectator and livestream leak tests | ✅ passing |
| Real accounts, expiring sessions, stream tickets, rate limits, CSP | ✅ done |
| Backup and restore, tested to restore an identical database | ✅ done |
| Load test: 60 rooms / 420 people / 840 live streams, p95 6 ms, 0 errors | ✅ done |
| Accessibility: 18 screens, no WCAG 2.1 A/AA violations (axe-core); keyboard token movement | ✅ done |
| Docker Compose with HTTPS (Caddy), health check, graceful shutdown, daily backups | ✅ written and validated (`docker compose config`); **not yet started on a real server** |
| CI workflow | ✅ written; **runs on its first push to GitHub** |
| A restore drill on the real server, with off-server copies | ☐ operator |
| Privacy notice and terms published (draft below) | ☐ operator, needs review |
| A way for beta users to report problems (email address, form or issue tracker) | ☐ operator |
| Verify the three SRD 5.2.1 data points (Trident, Sling, Rogue skills) against the PDF | ☐ open since Milestone 4 |

## Suggested beta shape

- **Closed beta first:** invite GMs you know; they invite their players. Display-name sign-in stays off.
- Start with a handful of campaigns on one server (the load test shows lots of headroom: the risk is bugs, not load).
- Ask GMs to run one live session (voice/video, 2D and 3D) and one downtime + world simulation cycle, then collect
  feedback.

## What beta users should know (put this on the sign-up page or an "About" page)

- This is a beta: back up anything precious outside the app; the operator takes daily backups.
- Voice and video go through the operator's own LiveKit server; nothing is recorded.
- Livestreams show only what a spectator may see, and only characters whose players agreed.
- Images you link (portraits, maps) are loaded from wherever they are hosted.
- No email is sent by the app; ask the operator if you forget your password.

## Privacy notice (draft for the operator to adapt and have reviewed)

> **What we store.** Your display name, email address and a scrambled (hashed) form of your password; the worlds,
> campaigns, characters, notes, chat messages and dice rolls you create; and a log of actions (who did what, when) used
> to keep campaigns consistent and to investigate problems.
>
> **What we do not do.** We do not sell or share your data, show ads, or record voice or video calls. Livestreams of a
> campaign show your character only if you tick "Show this character on the campaign livestream" on your sheet.
>
> **Your choices.** Under "Account" you can download all data about you, change your email and password, sign out
> everywhere, and delete your account. Deleting removes your name, email, password and campaign memberships; characters
> stay in their campaigns as "Former player" so the game master's records stay whole. Past chat messages keep the name
> they were sent under; ask the game master to delete them.
>
> **Where.** Data is stored on [server location/provider]. Backups are kept for 14 days. Contact: [operator email].

## After the beta (from the debt list)

Email verification and self-service password reset; moving sessions to HttpOnly cookies; per-user stream caps; invite
expiry; multi-process deployment (shared fan-out); Firefox/Safari and screen-reader testing; direct RTMP output for
livestreams; the remaining rules automation listed in MILESTONES.md.
