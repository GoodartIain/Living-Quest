-- Milestone 12: a player's consent to show their character on the livestream's party panel.
-- Presentation settings (playlist, camera, overlays, polls, highlights) live in campaigns.broadcast (jsonb).
ALTER TABLE characters ADD COLUMN on_stream boolean NOT NULL DEFAULT false;
