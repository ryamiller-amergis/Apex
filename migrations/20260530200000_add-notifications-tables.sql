-- Up Migration
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_read_created
  ON notifications (user_id, read, created_at DESC);

CREATE TABLE notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES app_users(oid) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  toast_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, notification_type)
);

-- Down Migration
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS notifications;
