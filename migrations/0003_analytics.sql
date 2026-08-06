CREATE TABLE IF NOT EXISTS page_view (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  path TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_page_view_date ON page_view (date);
CREATE INDEX IF NOT EXISTS idx_page_view_date_path ON page_view (date, path);
