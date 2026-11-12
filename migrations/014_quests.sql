-- Milestone 10: quest log, GM-authored side-quest adventures, their play-throughs, and scene interaction triggers.
CREATE TABLE quests (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  title text NOT NULL,
  description text NOT NULL,
  notes text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('main', 'optional', 'personal', 'downtime', 'faction')),
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party')),
  status text NOT NULL CHECK (status IN ('active', 'completed', 'failed')),
  character_id text REFERENCES characters DEFERRABLE INITIALLY DEFERRED,
  objectives jsonb NOT NULL
);
CREATE INDEX quests_campaign ON quests (campaign_id);

CREATE TABLE adventures (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  title text NOT NULL,
  summary text NOT NULL,
  start text NOT NULL,
  nodes jsonb NOT NULL,
  max_gp integer NOT NULL,
  max_xp integer NOT NULL
);

CREATE TABLE quest_runs (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  adventure_id text NOT NULL REFERENCES adventures DEFERRABLE INITIALLY DEFERRED,
  character_id text NOT NULL REFERENCES characters DEFERRABLE INITIALLY DEFERRED,
  user_id text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  action_id text NOT NULL REFERENCES downtime_actions DEFERRABLE INITIALLY DEFERRED,
  node text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'waiting', 'finished', 'abandoned')),
  path jsonb NOT NULL,
  effects jsonb NOT NULL,
  question text NOT NULL,
  answer text NOT NULL,
  outcome jsonb
);
CREATE INDEX quest_runs_action ON quest_runs (action_id);

CREATE TABLE triggers (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  scene_id text NOT NULL REFERENCES scenes DEFERRABLE INITIALLY DEFERRED,
  name text NOT NULL,
  text text NOT NULL,
  x integer NOT NULL,
  y integer NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('gm', 'party', 'public')),
  once boolean NOT NULL,
  reveal_fog jsonb,
  show_token_id text,
  event jsonb,
  used_at text
);
CREATE INDEX triggers_scene ON triggers (scene_id);
