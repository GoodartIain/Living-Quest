-- Livestream settings per campaign: on/off, the hashed secret link key, on-air scene, title, what is shown.
ALTER TABLE campaigns ADD COLUMN broadcast jsonb;
