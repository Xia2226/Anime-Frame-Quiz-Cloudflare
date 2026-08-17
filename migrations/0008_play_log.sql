-- 每次游玩记录：进入游戏（点击开始）即记录一行，完成有效对局后回填成绩。
-- 排行榜仍由 daily_best 只保留每人每日最好成绩，其余成绩按时间顺序保存在此表。
CREATE TABLE IF NOT EXISTS play_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('classic', 'hard', 'free')),
  participant_id TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  question_count INTEGER NOT NULL DEFAULT 0,
  accuracy_ppm INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_play_log_day ON play_log (day_key);
CREATE INDEX IF NOT EXISTS idx_play_log_started ON play_log (started_at);
