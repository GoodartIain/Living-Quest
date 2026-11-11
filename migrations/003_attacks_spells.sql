-- Weapons the character carries (SRD weapon names), their spell list, and expended spell slots ({ "1": 2, "pact": 1 }).
ALTER TABLE characters
  ADD COLUMN weapons jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN spells jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN slots_used jsonb NOT NULL DEFAULT '{}';
