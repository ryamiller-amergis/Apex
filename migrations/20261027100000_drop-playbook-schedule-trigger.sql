-- A Playbook starts from Run now. Drop the daily trigger columns.

-- Up Migration

DROP INDEX IF EXISTS idx_playbook_definitions_daily_schedule;

ALTER TABLE playbook_definitions
  DROP CONSTRAINT IF EXISTS playbook_definitions_schedule_shape_check,
  DROP CONSTRAINT IF EXISTS playbook_definitions_schedule_minute_check,
  DROP CONSTRAINT IF EXISTS playbook_definitions_schedule_kind_check;

ALTER TABLE playbook_definitions
  DROP COLUMN IF EXISTS schedule_set_by,
  DROP COLUMN IF EXISTS last_scheduled_at,
  DROP COLUMN IF EXISTS schedule_minute,
  DROP COLUMN IF EXISTS schedule_hour,
  DROP COLUMN IF EXISTS schedule_kind;

-- Down Migration

ALTER TABLE playbook_definitions
  ADD COLUMN schedule_kind text NOT NULL DEFAULT 'manual',
  ADD COLUMN schedule_hour integer,
  ADD COLUMN schedule_minute integer NOT NULL DEFAULT 0,
  ADD COLUMN last_scheduled_at timestamptz,
  ADD COLUMN schedule_set_by text REFERENCES app_users(oid) ON DELETE RESTRICT;

ALTER TABLE playbook_definitions
  ADD CONSTRAINT playbook_definitions_schedule_kind_check
    CHECK (schedule_kind IN ('manual', 'daily')),
  ADD CONSTRAINT playbook_definitions_schedule_minute_check
    CHECK (schedule_minute BETWEEN 0 AND 59),
  ADD CONSTRAINT playbook_definitions_schedule_shape_check
    CHECK (
      (schedule_kind = 'manual' AND schedule_hour IS NULL AND schedule_set_by IS NULL)
      OR (
        schedule_kind = 'daily'
        AND schedule_hour BETWEEN 0 AND 23
        AND schedule_set_by IS NOT NULL
      )
    );

CREATE INDEX idx_playbook_definitions_daily_schedule
  ON playbook_definitions (schedule_hour, schedule_minute)
  WHERE schedule_kind = 'daily';
