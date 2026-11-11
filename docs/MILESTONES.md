# Milestone tracker

Status reflects code in this repository, not intent.

| # | Milestone | Status |
|---|---|---|
| 0 | Architecture and foundation | Design docs done (`ARCHITECTURE.md`); repo + test runner done. Stack deviation: no Next.js/Postgres yet (see debt). |
| 1 | Accounts and campaign creation | **Done (dev auth).** Worlds with ruleset/advancement/autonomy/calendar/visibility settings, campaigns with inherited or overridden advancement, confirmed mode switch, single-use player/spectator invites, server-side roles. |
| 2 | Worldbuilding and hierarchical maps | **Done.** Location tree with per-location map (image URL + pins) and wiki page; standalone wiki entries (NPC, faction, item, lore…); relationships between entries; `[[links]]` stored by id with backlinks; Markdown rendering; search; page version history with restore; per-campaign discovery; visibility tiers and GM notes enforced on every response. |
| 3–13 | Tabletop, characters, comms, 3D, spectator broadcast, downtime, NPCs, … | Not started (designed in `ARCHITECTURE.md`). |

## Acceptance

`create world → campaign → configure advancement → create town → add location → link map + wiki page → invite player → navigate world map → town → location`

- Automated: `node --test test/*.test.js` — passes (also checks spectator/player/GM visibility, rename stability, persistence, event log).
- Manual (Chromium via Playwright): GM builds Aster → Greyhaven → Gilded Gull + hidden Smugglers Den, invites player; player navigates by map pin and list, sees lore, does not see GM notes or the hidden place. Passed.

Milestone 2: *a player selects a town on the world map, opens its town map, selects a tavern and views authorised information about its inhabitants.*

- Automated: second test in `test/slice.test.js` — tavern shows Mara (party) but not Hob (GM-only); Mara's page hides GM notes, her GM-only faction link and the undiscovered crypt (`[unknown]`); discovery is per campaign and hides subtrees; search skips GM notes for players; history/restore; renames update rendered links. Passes.
- Manual (Chromium): GM creates Mara with `**[[Gilded Gull]]**` and a link to the hidden crypt, connects her to the tavern; player opens world map pin → Greyhaven → Gilded Gull → Mara, sees the link, `[unknown]` for the crypt, no notes; search for a GM-note word finds nothing; GM ticks the crypt discovered and it appears for the player. Passed (found and fixed: links inside bold were not rendered).

## Known debt / defects

- Auth is a display name + bearer token in localStorage. Replace with real accounts (OIDC or email magic link) before any public hosting.
- Storage is one JSON file rewritten per mutation; fine for one table, not for concurrent servers. Move to Postgres per ERD.
- No rate limiting, no CSRF concern yet (bearer header, no cookies).
- Map images are external URLs, not uploaded assets.
- No URL routing: reloading the page returns to the world list.
- Search is substring over all pages in memory; fine for hundreds of pages, replace with Postgres full-text.
- Not done from the wider §4.3 wish list: collaborative (Yjs) editing, templates, custom metadata fields, relationship graph view, embedded media, import/export, knowledge-dependent marker text.
- Next.js / Tailwind / Prisma from the preferred stack are not introduced yet: the slice did not need them. Introduce with Milestone 3 (PixiJS tabletop) when a build step pays for itself.

## Recommended next action

Postgres migration (the JSON file now also holds revisions and grows with every edit), then Milestone 3: PixiJS scene with tokens over WebSocket.
