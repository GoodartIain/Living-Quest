-- Milestone 8: campaign clock (whole in-game days) and downtime windows with per-character activity bookings.
ALTER TABLE campaigns ADD COLUMN clock jsonb;

CREATE TABLE downtimes (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  start_day integer NOT NULL,
  end_day integer NOT NULL CHECK (end_day > start_day),
  deadline text,
  activities jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'paused', 'published', 'cancelled')),
  report jsonb,
  created_by text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  published_at text
);
CREATE INDEX downtimes_campaign ON downtimes (campaign_id);

CREATE TABLE downtime_actions (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  downtime_id text NOT NULL REFERENCES downtimes DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  character_id text NOT NULL REFERENCES characters DEFERRABLE INITIALLY DEFERRED,
  user_id text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  activity text NOT NULL,
  start_day integer NOT NULL,
  days integer NOT NULL,
  details text NOT NULL,
  claim text,
  status text NOT NULL CHECK (status IN ('proposed', 'resolved', 'conflicted', 'approved', 'rejected', 'cancelled')),
  outcome jsonb,
  gm_notes text NOT NULL,
  decided_by text REFERENCES users DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX downtime_actions_downtime ON downtime_actions (downtime_id);
