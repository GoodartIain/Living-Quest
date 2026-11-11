-- Multiclassing (which character levels went to which class) and per-world homebrew species, backgrounds and classes.
ALTER TABLE characters ADD COLUMN multiclass jsonb NOT NULL DEFAULT '{}';

CREATE TABLE homebrew (
  id text PRIMARY KEY, ord bigserial,
  world_id text NOT NULL REFERENCES worlds DEFERRABLE INITIALLY DEFERRED,
  kind text NOT NULL CHECK (kind IN ('species', 'background', 'class')),
  name text NOT NULL,
  data jsonb NOT NULL,
  UNIQUE (world_id, name)
);
