-- RFP evaluation reasoning chat (ask about a completed evaluation)

-- Up Migration

CREATE TABLE rfp_evaluation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rfp_request_id UUID NOT NULL REFERENCES rfp_requests(id) ON DELETE CASCADE,
  evaluation_id UUID REFERENCES rfp_evaluations(id) ON DELETE SET NULL,
  author_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rfp_evaluation_messages_role_check CHECK (role IN ('user', 'assistant'))
);

CREATE INDEX idx_rfp_evaluation_messages_request_created
  ON rfp_evaluation_messages (rfp_request_id, created_at ASC);

-- Down Migration

DROP INDEX IF EXISTS idx_rfp_evaluation_messages_request_created;
DROP TABLE IF EXISTS rfp_evaluation_messages;
