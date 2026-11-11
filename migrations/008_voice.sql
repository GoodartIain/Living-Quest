-- Voice/video settings per campaign: whether spectators may listen, and players the GM has muted.
ALTER TABLE campaigns ADD COLUMN voice jsonb NOT NULL DEFAULT '{"spectators": "none", "muted": []}';
