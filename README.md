# Living Quest

Browser tabletop / worldbuilding platform. This repository holds Milestones 1–3: worlds, campaigns, advancement settings, invites, nested maps, a linked wiki (NPCs, factions, lore) with relationships, backlinks, search, history and per-campaign discovery, and a live 2D tabletop (tokens, fog of war, measuring, encounters), all with server-enforced visibility.

```sh
node server.js            # http://localhost:3000, data in ./data.json (PORT, DATA_FILE override)
node --test test/*.test.js
```

No dependencies; Node 22+. Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Status: [docs/MILESTONES.md](docs/MILESTONES.md).
