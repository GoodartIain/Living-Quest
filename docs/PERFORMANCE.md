# Performance and scale (Milestone 13)

Measured on the build container (shared cloud VM, Node 22, PostgreSQL 16 on the same machine). Re-run them on your own
server before a beta; the scripts print the same figures.

## Multiplayer load (`scripts/load-test.js`)

Each room is a campaign with a GM and 6 players, all with the live scene and chat streams open; every player moves their
token once a second and chats about every 10 s. "Latency" is from sending a move until **all 6 other people in the room**
have received it (request, storage in PostgreSQL, per-viewer projection, fan-out).

| Rooms | People | Live streams | Moves/s | Delivered to all | p50 | p95 | p99 | Max | Errors | Server RSS / CPU |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 10 | 70 | 140 | 60 | 1,799 / 1,799 | 2 ms | 3 ms | 5 ms | 7 ms | 0 | 99 MB / 13% |
| 30 | 210 | 420 | 180 | 5,399 / 5,399 | 2 ms | 5 ms | 8 ms | 37 ms | 0 | 110 MB / 28% |
| 60 | 420 | 840 | 147* | 4,422 / 4,422 | 2 ms | 6 ms | 11 ms | 22 ms | 0 | 128 MB / 45% |

\* At 60 rooms the single load-generator process was the bottleneck (it parses every viewer's stream), not the server,
which stayed under half a CPU. Run several generators from other machines to push further.

How to run: start the server with `SIGNUPS_PER_HOUR=100000 RATE_LIMIT_PER_MINUTE=1000000` (the generator signs up hundreds
of accounts from one address), then `BASE_URL=… ROOMS=30 SECONDS=30 node scripts/load-test.js`. It passes when p95 is
under 500 ms with no errors.

Voice and video are not part of this test: LiveKit carries media separately and scales on its own (see DEPLOY.md).

## NPCs (`test/scale.test.js`)

3,000 NPCs with four-step daily routines and a reaction each, 40 of them standing on a scene:

| Operation | Time |
| --- | ---: |
| List every NPC with where they are now | 119 ms |
| Advance one day (12,000 routine steps logged, scene tokens updated) | 59 ms |
| Advance 30 days (one summary line per NPC instead of 360,000 steps) | 11 ms |
| A city-wide fire every NPC reacts to | 166 ms |

NPCs are rows, not processes: nothing runs between clock moves, so a world with thousands of NPCs costs nothing while
idle.

## World simulation (`test/scale.test.js`)

Two factions with five bounded activities over a year: 1,047 changes committed in 60 ms; influence, resources and
standings stay inside their bounds; no change exceeds its rule's size. Consistency: committing 7 days and then 7 days
gives exactly the 14-day preview, and replaying the change log from the starting values reproduces the stored state.

## 2D/3D compatibility (`scripts/compat-2d3d.js`)

One scene with fog, walls, a trigger, tokens of sizes 1–3 and every visibility, an NPC token, a character token and an
encounter, opened by the GM, a player and a spectator in the 2D board, 3D tactical and 3D first person, and on the
livestream page in 2D and 3D. In all 11 views the tokens drawn are exactly the tokens the server sent that viewer
(GM 6, player 4, spectator 3 — hidden and fogged ones absent), the trigger appears in every scene view, and nothing throws.
Only Chromium (with software WebGL) is available in the build environment; Firefox and Safari have not been tested.

## Limits to know about

- One app process per database (ARCHITECTURE §11): it finds changes by comparing rows in memory, fine for a group's
  worlds (the tests above), not for hosting many large worlds on one server.
- The per-request diff grows with the number of mutable rows; the documented comfortable range is up to about 10,000.
