-- Up Migration: Safe Trace Event Storage (observability capture foundation)

CREATE TABLE trace_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_user_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  project_id TEXT,
  trace_id TEXT NOT NULL,
  session_id TEXT,
  route_template TEXT,
  http_method TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  severity TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trace_events_event_type_check
    CHECK (event_type IN ('api_request', 'error', 'ui_action', 'agent_event')),
  CONSTRAINT trace_events_trace_id_check
    CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  CONSTRAINT trace_events_status_code_check
    CHECK (status_code IS NULL OR (status_code >= 100 AND status_code <= 599)),
  CONSTRAINT trace_events_duration_ms_check
    CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT trace_events_route_template_check
    CHECK (route_template IS NULL OR position('?' IN route_template) = 0),
  CONSTRAINT trace_events_details_object_check
    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX idx_trace_events_actor_occurred
  ON trace_events (actor_user_id, occurred_at DESC, id);

CREATE INDEX idx_trace_events_trace_occurred
  ON trace_events (trace_id, occurred_at);

CREATE INDEX idx_trace_events_session_occurred
  ON trace_events (session_id, occurred_at)
  WHERE session_id IS NOT NULL;

CREATE INDEX idx_trace_events_route_occurred
  ON trace_events (route_template, occurred_at);

CREATE INDEX idx_trace_events_occurred
  ON trace_events (occurred_at DESC);

CREATE TABLE trace_path_rollups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_route TEXT NOT NULL,
  to_route TEXT NOT NULL,
  day DATE NOT NULL,
  transition_count INTEGER NOT NULL DEFAULT 0,
  distinct_actor_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trace_path_rollups_from_to_day_key UNIQUE (from_route, to_route, day),
  CONSTRAINT trace_path_rollups_from_route_check
    CHECK (position('?' IN from_route) = 0),
  CONSTRAINT trace_path_rollups_to_route_check
    CHECK (position('?' IN to_route) = 0),
  CONSTRAINT trace_path_rollups_counts_check
    CHECK (transition_count >= 0 AND distinct_actor_count >= 0)
);

INSERT INTO feature_flags (
  key,
  description,
  enabled,
  lifecycle,
  cleanup_ready,
  created_by
)
VALUES (
  'observability-capture',
  'Captures redacted Trace Events for Observability. Disabled by default; enable for internal traffic first.',
  false,
  'active',
  false,
  NULL
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DELETE FROM feature_flags
WHERE key = 'observability-capture';

DROP TABLE IF EXISTS trace_path_rollups;
DROP TABLE IF EXISTS trace_events;
