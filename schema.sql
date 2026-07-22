-- Dev chat history: every message between Timothy and the in-PWA AI
CREATE TABLE IF NOT EXISTS dev_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,              -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Self-modification audit log: every time the AI proposes/writes a file change
CREATE TABLE IF NOT EXISTS mod_log (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  action TEXT NOT NULL,            -- 'propose' | 'commit' | 'reject'
  diff_summary TEXT,
  github_commit_sha TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Simple key/value settings (model choice, active repo branch, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
