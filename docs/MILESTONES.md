# Milestone tracker

Status reflects code in this repository, not intent.

| # | Milestone | Status |
|---|---|---|
| 0 | Architecture and foundation | Design docs done (`ARCHITECTURE.md`); repo + test runner done. PostgreSQL storage with versioned migrations and Docker Compose done. Stack deviation: no Next.js/Tailwind/ORM (see debt). |
| 1 | Accounts and campaign creation | **Done (dev auth).** Worlds with ruleset/advancement/autonomy/calendar/visibility settings, campaigns with inherited or overridden advancement, confirmed mode switch, single-use player/spectator invites, server-side roles. |
| 2 | Worldbuilding and hierarchical maps | **Done.** Location tree with per-location map (image URL + pins) and wiki page; standalone wiki entries (NPC, faction, item, lore…); relationships between entries; `[[links]]` stored by id with backlinks; Markdown rendering; search; page version history with restore; per-campaign discovery; visibility tiers and GM notes enforced on every response. |
| 3 | 2D tabletop | **Done.** Scenes on any location (square or gridless, size, background image, share level), tokens with colour/size/visibility/controlling player/optional wiki link, GM-painted fog of war, measuring (5 ft squares), encounter tracker (initiative order, turns, rounds; hidden combatants and their turns stay hidden), live sync to every viewer, each with their own filtered view. |
| 4 | Character creation and advancement | **Done.** Seven-step guided creation (SRD 5.2.1: 9 species, 12 classes, 4 backgrounds, standard array or point buy), character sheets with clickable checks/saves, HP/temp HP, conditions, inventory and currency, server-side dice with public/private/GM-only rolls and a scene dice log, XP awards by category to a character or the party, milestone awards, automatic or GM-approved level-ups, level history, tokens linked to characters. |
| 5–13 | Comms, 3D, spectator broadcast, downtime, NPCs, … | Not started (designed in `ARCHITECTURE.md`). |

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

Milestone 4: *characters progress according to the GM-selected method, and authorised changes synchronise with their tokens.*

- Automated: `test/characters.test.js` — SRD rules (derived numbers for a Dwarf Fighter and an Alert initiative bonus, every creation rule rejected when broken), dice (formulas, advantage/disadvantage, bad input), and the API flow: server-validated creation; summary vs full sheet vs 404; XP to the party with GM approval, HP rising on level-up; automatic level-ups for one character (1 → 4) with the ledger as history; milestone awards refused in XP campaigns and vice versa; switching to milestones keeps levels; tokens show the character's name, conditions and HP (HP only to owner and GM) and update live on damage, rename and level-up; rolls are generated server-side and hidden by visibility. Mutation-checked (HP leaked to all players; ignoring the GM's confirm setting). 10/10 pass in memory and on PostgreSQL 16, including a restart round-trip with characters, ledger and rolls.
- Manual (Chromium, server on PostgreSQL): player builds a Dwarf Fighter through the wizard; rolls Athletics from the sheet (+5); GM awards 300 XP to the party, sees "1 level-up pending", approves it (HP 13 → 22); GM links a token to the character; the player sees its HP bar change live when the GM deals 7 damage (22 → 15); a player's scene roll appears in the GM's dice log. Passed. Found and fixed: changing background wiped class skills chosen earlier; nested lists rendered as `[object HTMLLabelElement]`; leaving a sheet showed a stale location (missing a new scene); the currency row overflowed the page. Milestone 3's browser flow re-run and still passes.

Spells and attacks (Milestone 4 follow-up):

- Automated: fourth test in `test/characters.test.js` — weapon proficiency and abilities for a Rogue (finesse, light hand crossbow proficient; longsword not), slot tables (Paladin 1, Wizard 3 and 20, Warlock 11 pact slots), DC/attack bonus; API: unknown weapons refused; to-hit, damage, two-handed and critical formulas come from the sheet; spell list validation; cantrips free; save spells show the DC; utility spells spend a slot without a roll; out-of-slot and missing-slot-level casts refused; upcasting after levelling; long rest restores slots and HP; Warlock pact slot spent, refused, restored by a short rest; outsiders refused; a refused cast spends nothing. Mutation-checked (weapon proficiency rule removed; slot limit ignored). 11/11 pass in memory and on PostgreSQL.
- Manual (Chromium, PostgreSQL): GM adds a Quarterstaff to a Gnome Wizard, rolls to-hit (+1), two-handed damage (1d8−1) and a critical (2d6−1); adds Fire Bolt and Burning Hands; Fire Bolt rolls +5 to hit and 1d10 fire without using a slot; Burning Hands shows "DC 13 DEX save" and spends a slot; the third cast is refused with "no level 1 slots left"; a long rest restores both slots. Passed.

## Known debt / defects

- Auth is a display name + bearer token in localStorage. Replace with real accounts (OIDC or email magic link) before any public hosting.
- Storage (PostgreSQL, `store.js`) runs as one app process per database and finds changes by comparing rows in memory; fine for a group's worlds, not for hosting many large worlds on one server. See ARCHITECTURE §11.
- `docker-compose.yml` and `Dockerfile` were written but not run (no Docker daemon in the build environment). The same app and migrations were tested against a local PostgreSQL 16.
- No rate limiting, no CSRF concern yet (bearer header, no cookies).
- Map images are external URLs, not uploaded assets.
- No URL routing: reloading the page returns to the world list.
- Characters: no built-in spell catalogue (players enter their spells; casting, slots, DC and rolls are automated), no automatic cantrip or upcast damage scaling (enter the formula you need), no prepared-spell limits, no weapon mastery properties, no custom weapons, no class features that change attacks (e.g. Monk Martial Arts), no armour (AC is unarmored), starting equipment packages, level-up choices (subclass, ability score improvements, feats, new class features), multiclassing, death saves, hit dice on short rests, character journal, Human/Tiefling size choice, or GM-defined custom species/classes/backgrounds. Initiative rolls are not fed into the encounter tracker automatically. "Keep party levels aligned" is not an option.
- Tabletop: no hex grid, no drawing tool, no dynamic lighting/line of sight, no HP/conditions on tokens without a character, controllers can only be set when the token is created (the API accepts changes, the UI does not offer it), measurement is not shared with other players.
- The stream URL carries the session token as a query parameter (browsers cannot set headers on EventSource); it can end up in proxy logs. Replace with a short-lived stream ticket when real auth lands.
- Search is substring over all pages in memory; fine for thousands of pages, add a Postgres full-text pre-filter beyond that.
- Not done from the wider §4.3 wish list: collaborative (Yjs) editing, templates, custom metadata fields, relationship graph view, embedded media, import/export, knowledge-dependent marker text.
- Next.js / Tailwind / Prisma from the preferred stack are not introduced yet: the slice did not need them. Introduce with Milestone 3 (PixiJS tabletop) when a build step pays for itself.

## Recommended next action

Milestone 5: live voice/video sessions (LiveKit), chat and whispers, and the GM Director Mode foundation. LiveKit is new infrastructure (a media server, self-hosted or LiveKit Cloud), so decide hosting first. Smaller alternatives: armour and AC, or an SRD spell catalogue checked against the SRD 5.2.1 text.
