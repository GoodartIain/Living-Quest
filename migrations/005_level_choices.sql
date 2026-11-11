-- Level-up choices (subclass, feats, ability increases, fighting styles, epic boons) and the chosen subclass.
ALTER TABLE characters
  ADD COLUMN choices jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN subclass text;
