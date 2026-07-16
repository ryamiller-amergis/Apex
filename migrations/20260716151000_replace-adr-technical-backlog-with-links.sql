DROP INDEX IF EXISTS idx_dev_sessions_technical_backlog_item;

ALTER TABLE dev_sessions
  DROP COLUMN IF EXISTS technical_backlog_item_id;

DROP INDEX IF EXISTS idx_technical_backlog_project_status;

DROP TABLE IF EXISTS technical_backlog_items;

CREATE TABLE IF NOT EXISTS feature_request_adrs (
  feature_request_id UUID NOT NULL
    REFERENCES feature_requests(id) ON DELETE CASCADE,
  adr_id UUID NOT NULL
    REFERENCES adrs(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (feature_request_id, adr_id)
);

CREATE INDEX IF NOT EXISTS idx_feature_request_adrs_adr_id
  ON feature_request_adrs(adr_id);
