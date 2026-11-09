-- Up Migration

CREATE TABLE IF NOT EXISTS chat_thread_outputs (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  run_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, path)
);

COMMENT ON TABLE chat_thread_outputs IS
  'Files a V2 chat turn wrote under .ai-pilot/. App Service reads them here instead of from the thread folder on the file share.';
COMMENT ON COLUMN chat_thread_outputs.path IS
  'Path relative to the thread workspace, for example .ai-pilot/output/module-scoping.json.';

-- Down Migration

DROP TABLE IF EXISTS chat_thread_outputs;
