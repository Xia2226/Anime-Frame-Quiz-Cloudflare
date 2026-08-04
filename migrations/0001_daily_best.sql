CREATE TABLE IF NOT EXISTS daily_best (
  day_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('classic', 'hard')),
  participant_id TEXT NOT NULL,
  username TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL,
  question_count INTEGER NOT NULL,
  accuracy_ppm INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, mode, participant_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_daily_best_classic_score
  ON daily_best (day_key, mode, score DESC, elapsed_ms ASC, completed_at ASC)
  WHERE mode = 'classic';

CREATE INDEX IF NOT EXISTS idx_daily_best_hard
  ON daily_best (
    day_key,
    mode,
    accuracy_ppm DESC,
    question_count DESC,
    elapsed_ms ASC,
    completed_at ASC
  )
  WHERE mode = 'hard';
