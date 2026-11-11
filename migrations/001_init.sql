-- Living Quest schema v1 (Milestones 1–3). Foreign keys are deferred so one transaction can insert rows in any order.
-- `ord` keeps insertion order, which the app relies on for stable lists.

CREATE TABLE users (
  id text PRIMARY KEY, ord bigserial,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE
);

CREATE TABLE worlds (
  id text PRIMARY KEY, ord bigserial,
  owner_id text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  settings jsonb NOT NULL,
  root_location_id text NOT NULL
);

CREATE TABLE campaigns (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  advancement jsonb NOT NULL
);

CREATE TABLE memberships (
  id text PRIMARY KEY, ord bigserial,
  user_id text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  role text NOT NULL CHECK (role IN ('player', 'spectator'))
);
CREATE INDEX memberships_user_world ON memberships (user_id, world_id);

CREATE TABLE invites (
  id text PRIMARY KEY, ord bigserial,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  role text NOT NULL CHECK (role IN ('player', 'spectator')),
  created_by text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  accepted_by text REFERENCES users DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE maps (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  location_id text NOT NULL,
  name text NOT NULL,
  image_url text NOT NULL DEFAULT ''
);

CREATE TABLE locations (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  parent_id text REFERENCES locations DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  type text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party', 'public')),
  requires_discovery boolean NOT NULL DEFAULT false,
  map_id text NOT NULL REFERENCES maps DEFERRABLE INITIALLY DEFERRED,
  page_id text NOT NULL
);
CREATE INDEX locations_world_parent ON locations (world_id, parent_id);

CREATE TABLE pages (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  location_id text REFERENCES locations DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party', 'public')),
  title text NOT NULL,
  body text NOT NULL,
  gm_notes text NOT NULL
);
CREATE INDEX pages_world ON pages (world_id);
ALTER TABLE worlds ADD FOREIGN KEY (root_location_id) REFERENCES locations DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE maps ADD FOREIGN KEY (location_id) REFERENCES locations DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE locations ADD FOREIGN KEY (page_id) REFERENCES pages DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE relationships (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  from_id text NOT NULL REFERENCES pages DEFERRABLE INITIALLY DEFERRED,
  to_id text NOT NULL REFERENCES pages DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party', 'public'))
);
CREATE INDEX relationships_from ON relationships (from_id);
CREATE INDEX relationships_to ON relationships (to_id);

CREATE TABLE discoveries (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  location_id text NOT NULL REFERENCES locations DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (location_id, campaign_id)
);

CREATE TABLE revisions (
  id text PRIMARY KEY, ord bigserial,
  page_id text NOT NULL REFERENCES pages DEFERRABLE INITIALLY DEFERRED,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  at timestamptz NOT NULL,
  actor text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  title text NOT NULL,
  body text NOT NULL,
  gm_notes text NOT NULL,
  kind text,
  visibility text
);
CREATE INDEX revisions_page ON revisions (page_id);

CREATE TABLE scenes (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  location_id text NOT NULL REFERENCES locations DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  grid text NOT NULL CHECK (grid IN ('square', 'none')),
  cols integer NOT NULL CHECK (cols BETWEEN 1 AND 200),
  rows integer NOT NULL CHECK (rows BETWEEN 1 AND 200),
  background_url text NOT NULL DEFAULT '',
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party', 'public')),
  fog jsonb NOT NULL,
  encounter jsonb
);
CREATE INDEX scenes_location ON scenes (location_id);

CREATE TABLE tokens (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  scene_id text NOT NULL REFERENCES scenes DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  x double precision NOT NULL,
  y double precision NOT NULL,
  size integer NOT NULL,
  color text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party', 'public')),
  controlled_by jsonb NOT NULL,
  page_id text REFERENCES pages DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX tokens_scene ON tokens (scene_id);

-- Append-only audit log. Never updated or deleted by the app.
CREATE TABLE events (
  seq integer PRIMARY KEY, ord bigserial,
  at timestamptz NOT NULL,
  actor text,
  type text NOT NULL,
  data jsonb NOT NULL
);
