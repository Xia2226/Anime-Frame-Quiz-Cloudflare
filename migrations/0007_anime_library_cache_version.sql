CREATE TABLE IF NOT EXISTS anime_library_cache_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT OR IGNORE INTO anime_library_cache_version (id, version) VALUES (1, 0);
