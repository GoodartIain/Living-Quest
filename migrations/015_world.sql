-- Milestone 11: factions (starting values), GM-scheduled happenings, and the append-only log of world changes.
-- A campaign's faction state is its factions' starting values plus its world changes, in order.
CREATE TABLE factions (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  page_id text REFERENCES pages DEFERRABLE INITIALLY DEFERRED,
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party', 'public')),
  influence integer NOT NULL,
  resources integer NOT NULL,
  territory jsonb NOT NULL,
  standings jsonb NOT NULL,
  goals text NOT NULL,
  leader text NOT NULL,
  activities jsonb NOT NULL
);
CREATE INDEX factions_world ON factions (world_id);

CREATE TABLE happenings (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  time integer NOT NULL,
  label text NOT NULL,
  significance text NOT NULL CHECK (significance IN ('routine', 'minor', 'major', 'protected')),
  effects jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled', 'done', 'cancelled', 'skipped', 'blocked'))
);
CREATE INDEX happenings_campaign ON happenings (campaign_id, time);

CREATE TABLE world_changes (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  time integer NOT NULL,
  kind text NOT NULL,
  data jsonb NOT NULL,
  faction_id text,
  source text NOT NULL,
  significance text NOT NULL,
  by text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  commit_id text NOT NULL
);
CREATE INDEX world_changes_campaign ON world_changes (campaign_id, ord);
