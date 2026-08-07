CREATE TABLE IF NOT EXISTS anime_override (
  anidb_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
