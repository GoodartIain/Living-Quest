-- Milestone 4: characters, the advancement ledger (level history), dice rolls, and tokens linked to characters.

CREATE TABLE characters (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  owner_id text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  ruleset text NOT NULL,
  name text NOT NULL,
  portrait_url text NOT NULL DEFAULT '',
  personality text NOT NULL DEFAULT '',
  backstory text NOT NULL DEFAULT '',
  species text NOT NULL,
  class_name text NOT NULL,
  background text NOT NULL,
  ability_method text NOT NULL,
  base_scores jsonb NOT NULL,
  background_bonus jsonb NOT NULL,
  abilities jsonb NOT NULL,
  skills jsonb NOT NULL,
  feats jsonb NOT NULL,
  tools jsonb NOT NULL,
  hp jsonb NOT NULL,
  conditions jsonb NOT NULL,
  inventory jsonb NOT NULL,
  currency jsonb NOT NULL
);
CREATE INDEX characters_campaign ON characters (campaign_id);

-- Append-only: level and XP are sums over this table.
CREATE TABLE advancements (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  campaign_id text NOT NULL REFERENCES campaigns DEFERRABLE INITIALLY DEFERRED,
  character_id text NOT NULL REFERENCES characters DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL CHECK (kind IN ('xp', 'level')),
  amount integer NOT NULL CHECK (amount > 0),
  category text,
  reason text NOT NULL,
  by text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  auto boolean NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX advancements_character ON advancements (character_id);

CREATE TABLE rolls (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  scene_id text REFERENCES scenes DEFERRABLE INITIALLY DEFERRED,
  user_id text NOT NULL REFERENCES users DEFERRABLE INITIALLY DEFERRED,
  user_name text NOT NULL,
  character_id text REFERENCES characters DEFERRABLE INITIALLY DEFERRED,
  label text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private', 'gm')),
  formula text NOT NULL,
  mode text NOT NULL,
  total integer NOT NULL,
  parts jsonb NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX rolls_world ON rolls (world_id);
CREATE INDEX rolls_scene ON rolls (scene_id);

ALTER TABLE tokens ADD COLUMN character_id text REFERENCES characters DEFERRABLE INITIALLY DEFERRED;
