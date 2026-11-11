# Living Quest

Browser tabletop / worldbuilding platform. This repository holds Milestones 1–3: worlds, campaigns, advancement settings, invites, nested maps, a linked wiki (NPCs, factions, lore) with relationships, backlinks, search, history and per-campaign discovery, and a live 2D tabletop (tokens, fog of war, measuring, encounters), all with server-enforced visibility.

```sh
docker compose up                      # app + PostgreSQL 16, http://localhost:3000
```

Or run it yourself (Node 22+, PostgreSQL 14+):

```sh
npm install
DATABASE_URL=postgres://user:pass@localhost/livingquest npm start   # schema migrations run on start
npm start                                                          # no DATABASE_URL: in memory, nothing saved
npm test                                                           # in memory
TEST_DATABASE_URL=postgres://user:pass@localhost/lq_test npm test  # also the PostgreSQL tests; the test database is wiped
```

Upgrading from a version that saved to `data.json`: start with `DATABASE_URL` pointing at an empty database and the file is imported once (`DATA_FILE` sets its path).

One dependency: `pg`. Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Status: [docs/MILESTONES.md](docs/MILESTONES.md).
