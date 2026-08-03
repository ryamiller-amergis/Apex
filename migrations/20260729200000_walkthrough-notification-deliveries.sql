-- Up Migration
-- FEAT-007 PBI-009: Walkthrough publish notification idempotency ledger + notification dedupe key

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe_key
  ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE walkthrough_notification_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  walkthrough_id    UUID NOT NULL REFERENCES walkthroughs(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  user_id           TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  notification_id   UUID REFERENCES notifications(id) ON DELETE SET NULL,
  attempt_state     TEXT NOT NULL DEFAULT 'pending'
                      CHECK (attempt_state IN ('pending', 'delivered', 'failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error_class  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_walkthrough_notification_deliveries_wt_rev_user
    UNIQUE (walkthrough_id, revision, user_id)
);

CREATE INDEX idx_walkthrough_notification_deliveries_user_revision
  ON walkthrough_notification_deliveries (user_id, walkthrough_id, revision);

CREATE INDEX idx_walkthrough_notification_deliveries_state
  ON walkthrough_notification_deliveries (attempt_state)
  WHERE attempt_state IN ('pending', 'failed');

-- Down Migration
DROP TABLE IF EXISTS walkthrough_notification_deliveries;
DROP INDEX IF EXISTS uq_notifications_dedupe_key;
ALTER TABLE notifications DROP COLUMN IF EXISTS dedupe_key;
