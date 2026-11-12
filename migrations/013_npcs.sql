-- Milestone 9: NPC routines. The campaign clock gains a minute of the day (stored in the clock json, no DDL needed).
-- NPC profiles are world-level; reactions/overrides and the event history are per campaign and append-only.
ALTER TABLE tokens ADD COLUMN npc_id text;

CREATE TABLE npcs (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  page_id text REFERENCES pages DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  occupation text NOT NULL,
  home_location_id text REFERENCES locations DEFERRABLE INITIALLY DEFERRED,
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party', 'public')),
  autonomy text NOT NULL,
  importance text NOT NULL,
  color text NOT NULL,
  schedule jsonb NOT NULL,
  reactions jsonb NOT NULL
);
CREATE INDEX npcs_world ON npcs (world_id);

-- npc_id has no foreign key: history outlives a deleted NPC.
CREATE TABLE npc_events (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  npc_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reaction', 'override')),
  cause text NOT NULL,
  from_time integer NOT NULL,
  to_time integer NOT NULL CHECK (to_time > from_time),
  activity text NOT NULL,
  location_id text,
  scene_id text,
  x integer,
  y integer,
  after text NOT NULL,
  relocate jsonb
);
CREATE INDEX npc_events_campaign ON npc_events (campaign_id, npc_id);

CREATE TABLE npc_log (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  npc_id text,
  time integer NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  location_id text
);
CREATE INDEX npc_log_campaign ON npc_log (campaign_id, ord);
