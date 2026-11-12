-- Scene walls for the 3D view: segments along grid lines, [{ "x1", "y1", "x2", "y2" }] in cell-corner coordinates.
ALTER TABLE scenes ADD COLUMN walls jsonb NOT NULL DEFAULT '[]';
