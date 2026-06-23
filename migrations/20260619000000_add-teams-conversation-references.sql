-- Up Migration
CREATE TABLE teams_conversation_references (
  user_oid TEXT PRIMARY KEY REFERENCES app_users(oid) ON DELETE CASCADE,
  conversation_reference JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
