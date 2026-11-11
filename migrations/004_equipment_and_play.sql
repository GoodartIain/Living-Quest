-- Size choice, armour/shield, weapon masteries, rage, death saves, spent hit dice, character journal.
ALTER TABLE characters
  ADD COLUMN size text NOT NULL DEFAULT 'Medium',
  ADD COLUMN armor text,
  ADD COLUMN shield boolean NOT NULL DEFAULT false,
  ADD COLUMN masteries jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN raging boolean NOT NULL DEFAULT false,
  ADD COLUMN death_saves jsonb NOT NULL DEFAULT '{"successes": 0, "failures": 0}',
  ADD COLUMN hit_dice_used integer NOT NULL DEFAULT 0,
  ADD COLUMN journal jsonb NOT NULL DEFAULT '[]';
-- Existing characters get their species' size (Human and Tiefling default to Medium).
UPDATE characters SET size = 'Small' WHERE species IN ('Gnome', 'Halfling');
