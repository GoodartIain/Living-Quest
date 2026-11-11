# Milestone tracker

Status reflects code in this repository, not intent.

| # | Milestone | Status |
|---|---|---|
| 0 | Architecture and foundation | Design docs done (`ARCHITECTURE.md`); repo + test runner done. PostgreSQL storage with versioned migrations and Docker Compose done. Stack deviation: no Next.js/Tailwind/ORM (see debt). |
| 1 | Accounts and campaign creation | **Done (dev auth).** Worlds with ruleset/advancement/autonomy/calendar/visibility settings, campaigns with inherited or overridden advancement, confirmed mode switch, single-use player/spectator invites, server-side roles. |
| 2 | Worldbuilding and hierarchical maps | **Done.** Location tree with per-location map (image URL + pins) and wiki page; standalone wiki entries (NPC, faction, item, lore…); relationships between entries; `[[links]]` stored by id with backlinks; Markdown rendering; search; page version history with restore; per-campaign discovery; visibility tiers and GM notes enforced on every response. |
| 3 | 2D tabletop | **Done.** Scenes on any location (square or gridless, size, background image, share level), tokens with colour/size/visibility/controlling player/optional wiki link, GM-painted fog of war, measuring (5 ft squares), encounter tracker (initiative order, turns, rounds; hidden combatants and their turns stay hidden), live sync to every viewer, each with their own filtered view. |
| 4–13 | Characters, comms, 3D, spectator broadcast, downtime, NPCs, … | Not started (designed in `ARCHITECTURE.md`). |

## Acceptance

`create world → campaign → configure advancement → create town → add location → link map + wiki page → invite player → navigate world map → town → location`

- Automated: `node --test test/*.test.js` — passes (also checks spectator/player/GM visibility, rename stability, persistence, event log).
- Manual (Chromium via Playwright): GM builds Aster → Greyhaven → Gilded Gull + hidden Smugglers Den, invites player; player navigates by map pin and list, sees lore, does not see GM notes or the hidden place. Passed.

Milestone 2: *a player selects a town on the world map, opens its town map, selects a tavern and views authorised information about its inhabitants.*

- Automated: second test in `test/slice.test.js` — tavern shows Mara (party) but not Hob (GM-only); Mara's page hides GM notes, her GM-only faction link and the undiscovered crypt (`[unknown]`); discovery is per campaign and hides subtrees; search skips GM notes for players; history/restore; renames update rendered links. Passes.
- Manual (Chromium): GM creates Mara with `**[[Gilded Gull]]**` and a link to the hidden crypt, connects her to the tavern; player opens world map pin → Greyhaven → Gilded Gull → Mara, sees the link, `[unknown]` for the crypt, no notes; search for a GM-note word finds nothing; GM ticks the crypt discovered and it appears for the player. Passed (found and fixed: links inside bold were not rendered).

Milestone 3: *a GM and six players use a shared scene with correct visibility and permissions.*

- Automated: `test/tabletop.test.js` — GM, six players and a spectator; every player holds a live stream. Checks: scenes start GM-only; players see each other's heroes but never the GM-only goblin (asserted over every streamed message); fog hides unrevealed tokens except your own; each player can move only their own token, only its position, only in bounds; moves reach all six streams; spectator/outsider are refused; encounter hides the goblin and its turn; hiding the scene closes player streams. Mutation-checked: removing the visibility filter or the ownership check makes it fail. Passes.
- Manual (Chromium, GM + two players): GM creates a scene, places tokens with the form, shares it, enables fog and reveals a region by dragging; player Pia drags her hero and player Pax sees it move live; Pia cannot drag Pax's hero; measuring reads "3 squares · 15 ft"; encounter list on Pax's screen omits the goblin. Passed (found and fixed: switching tools wiped the new-token form; the encounter panel printed `[object …]`).

PostgreSQL move (between Milestones 3 and 4):

- `npm test` with `TEST_DATABASE_URL` runs every test above against a freshly reset PostgreSQL database, plus `test/postgres.test.js`: a full world (wiki, relationships incl. a delete, discovery, scene, fog, encounter, token move and delete) is identical after a restart; an old `data.json` is imported once with missing fields filled in; a write rejected by the database returns 500 and memory returns to the stored state (mutation-checked). 7/7 pass on PostgreSQL 16.
- Manual: the browser tabletop run above repeated with the server on PostgreSQL, then the server restarted; the dragged token's new position was in the database.

## Known debt / defects

- Auth is a display name + bearer token in localStorage. Replace with real accounts (OIDC or email magic link) before any public hosting.
- Storage (PostgreSQL, `store.js`) runs as one app process per database and finds changes by comparing rows in memory; fine for a group's worlds, not for hosting many large worlds on one server. See ARCHITECTURE §11.
- `docker-compose.yml` and `Dockerfile` were written but not run (no Docker daemon in the build environment). The same app and migrations were tested against a local PostgreSQL 16.
- No rate limiting, no CSRF concern yet (bearer header, no cookies).
- Map images are external URLs, not uploaded assets.
- No URL routing: reloading the page returns to the world list.
- Tabletop: no hex grid, no drawing tool, no dynamic lighting/line of sight, no token HP or conditions (come with characters in Milestone 4), controllers can only be set when the token is created (the API accepts changes, the UI does not offer it), measurement is not shared with other players.
- The stream URL carries the session token as a query parameter (browsers cannot set headers on EventSource); it can end up in proxy logs. Replace with a short-lived stream ticket when real auth lands.
- Search is substring over all pages in memory; fine for thousands of pages, add a Postgres full-text pre-filter beyond that.
- Not done from the wider §4.3 wish list: collaborative (Yjs) editing, templates, custom metadata fields, relationship graph view, embedded media, import/export, knowledge-dependent marker text.
- Next.js / Tailwind / Prisma from the preferred stack are not introduced yet: the slice did not need them. Introduce with Milestone 3 (PixiJS tabletop) when a build step pays for itself.

## Recommended next action

Milestone 4: character creation, sheets, server-side dice, XP and milestone advancement linked to tokens.
