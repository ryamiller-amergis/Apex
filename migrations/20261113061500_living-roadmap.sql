-- Up Migration
-- Living Roadmap Workbench storage: per-project settings, work-item planning overlays,
-- ad-hoc sandbox ideas, and an immutable drift & history ledger.

CREATE TABLE IF NOT EXISTS roadmap_project_settings (
  project           text PRIMARY KEY,
  sync_dates_to_ado boolean NOT NULL DEFAULT false,
  updated_by        text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap_plan_overlays (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project              text NOT NULL,
  work_item_id         integer NOT NULL,
  work_item_type       text NOT NULL DEFAULT 'Epic',
  horizon              text,
  planned_start_date   date,
  planned_target_date  date,
  baseline_target_date date,
  confidence           text,
  notes                text,
  sort_order           integer NOT NULL DEFAULT 0,
  updated_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roadmap_plan_overlays_horizon_check
    CHECK (horizon IS NULL OR horizon IN ('now', 'next', 'later', 'unplanned')),
  CONSTRAINT roadmap_plan_overlays_confidence_check
    CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_roadmap_plan_overlays_project_work_item
  ON roadmap_plan_overlays (project, work_item_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_plan_overlays_project
  ON roadmap_plan_overlays (project);

CREATE TABLE IF NOT EXISTS roadmap_adhoc_ideas (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project                     text NOT NULL,
  title                       text NOT NULL,
  owner_label                 text,
  horizon                     text NOT NULL DEFAULT 'later',
  effort_size                 text NOT NULL DEFAULT 'M',
  confidence                  text NOT NULL DEFAULT 'low',
  release_label               text,
  notes                       text,
  planned_start_date          date,
  planned_target_date         date,
  baseline_target_date        date,
  promoted_feature_request_id uuid,
  promoted_ado_work_item_id   integer,
  promoted_at                 timestamptz,
  archived                    boolean NOT NULL DEFAULT false,
  sort_order                  integer NOT NULL DEFAULT 0,
  created_by                  text NOT NULL,
  updated_by                  text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roadmap_adhoc_ideas_horizon_check
    CHECK (horizon IN ('now', 'next', 'later', 'unplanned')),
  CONSTRAINT roadmap_adhoc_ideas_effort_check
    CHECK (effort_size IN ('S', 'M', 'L', 'XL')),
  CONSTRAINT roadmap_adhoc_ideas_confidence_check
    CHECK (confidence IN ('high', 'medium', 'low'))
);

CREATE INDEX IF NOT EXISTS idx_roadmap_adhoc_ideas_project_archived
  ON roadmap_adhoc_ideas (project, archived);

CREATE TABLE IF NOT EXISTS roadmap_change_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project         text NOT NULL,
  work_item_id    integer,
  adhoc_idea_id   uuid REFERENCES roadmap_adhoc_ideas(id) ON DELETE SET NULL,
  item_title      text NOT NULL,
  item_origin     text NOT NULL,
  event_kind      text NOT NULL,
  from_horizon    text,
  to_horizon      text,
  old_target_date date,
  new_target_date date,
  delta_days      integer,
  reason          text NOT NULL,
  note            text,
  synced_to_ado   boolean NOT NULL DEFAULT false,
  actor_id        text NOT NULL,
  actor_name      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roadmap_change_events_origin_check
    CHECK (item_origin IN ('ado', 'board', 'adhoc')),
  CONSTRAINT roadmap_change_events_kind_check
    CHECK (event_kind IN ('horizon_changed', 'date_changed', 'baseline_locked', 'idea_created', 'idea_promoted')),
  CONSTRAINT roadmap_change_events_from_horizon_check
    CHECK (from_horizon IS NULL OR from_horizon IN ('now', 'next', 'later', 'unplanned')),
  CONSTRAINT roadmap_change_events_to_horizon_check
    CHECK (to_horizon IS NULL OR to_horizon IN ('now', 'next', 'later', 'unplanned'))
);

CREATE INDEX IF NOT EXISTS idx_roadmap_change_events_project_created
  ON roadmap_change_events (project, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS roadmap_change_events;
DROP TABLE IF EXISTS roadmap_adhoc_ideas;
DROP TABLE IF EXISTS roadmap_plan_overlays;
DROP TABLE IF EXISTS roadmap_project_settings;
