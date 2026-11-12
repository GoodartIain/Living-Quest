-- GM Director Mode per campaign: the live scene players are pointed to, private GM notes, story beats.
ALTER TABLE campaigns ADD COLUMN director jsonb NOT NULL DEFAULT '{"liveSceneId": null, "notes": "", "beats": []}';
