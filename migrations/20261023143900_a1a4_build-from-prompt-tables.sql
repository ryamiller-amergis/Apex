-- Build-from-prompt tables (FEAT-001 TBI-001).
-- Six tables, status checks, the frozen-column guard, and the append-only events guard.
-- Slot statuses are intake, planning, building, checking, deploying.
-- revision_cap counts change requests. The first build is revision 1 and does not consume the cap.
-- chain_head_key is set on every chain task (including the head) and null for own_agent.

-- Up Migration

CREATE TABLE build_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  repository TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  model_override TEXT,
  prompt TEXT NOT NULL,
  playbook_run_id UUID NOT NULL,
  playbook_step_run_id UUID,
  interview_id UUID,
  brief_id UUID,
  status TEXT NOT NULL DEFAULT 'queued',
  suspend_reason TEXT,
  suspended_from_status TEXT,
  current_revision_number INTEGER NOT NULL DEFAULT 1,
  revisions_used INTEGER NOT NULL DEFAULT 0,
  revision_cap INTEGER NOT NULL DEFAULT 5,
  integration_branch TEXT,
  base_commit TEXT,
  skill_snapshot JSONB NOT NULL,
  support_contacts JSONB NOT NULL,
  quality_manifest_snapshot JSONB NOT NULL,
  cost_cap_usd NUMERIC(12, 4) NOT NULL,
  cost_used_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  elapsed_cap_seconds INTEGER NOT NULL,
  parallelism_cap SMALLINT NOT NULL,
  parallelism_used SMALLINT NOT NULL DEFAULT 0,
  pull_request_url TEXT,
  pull_request_id INTEGER,
  accepted_revision_number INTEGER,
  integration_branch_deleted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_build_runs_requested_by FOREIGN KEY (requested_by_user_id) REFERENCES app_users (oid) ON DELETE RESTRICT,
  CONSTRAINT fk_build_runs_playbook_run FOREIGN KEY (playbook_run_id) REFERENCES playbook_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_build_runs_playbook_step_run FOREIGN KEY (playbook_step_run_id) REFERENCES playbook_step_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_build_runs_interview FOREIGN KEY (interview_id) REFERENCES interviews (id) ON DELETE RESTRICT,
  CONSTRAINT fk_build_runs_brief FOREIGN KEY (brief_id) REFERENCES interview_briefs (id) ON DELETE RESTRICT,
  CONSTRAINT build_runs_project_check CHECK (char_length(project) >= 1 AND project = btrim(project)),
  CONSTRAINT build_runs_repository_check CHECK (char_length(repository) >= 1 AND repository = btrim(repository)),
  CONSTRAINT build_runs_client_request_id_check CHECK (
    char_length(client_request_id) BETWEEN 1 AND 128 AND client_request_id = btrim(client_request_id)
  ),
  CONSTRAINT build_runs_prompt_check CHECK (char_length(btrim(prompt)) >= 1),
  CONSTRAINT build_runs_status_check CHECK (status IN (
    'queued', 'intake', 'planning', 'building', 'checking', 'deploying',
    'preview_ready', 'suspended', 'deployment_failed', 'needs_developer',
    'accepted', 'cancelled', 'failed'
  )),
  CONSTRAINT build_runs_suspend_reason_check CHECK (
    suspend_reason IS NULL OR suspend_reason IN (
      'cost_cap', 'elapsed_cap', 'repair_cap', 'flag_disabled',
      'permission_revoked', 'configuration', 'plan_invalid'
    )
  ),
  CONSTRAINT build_runs_suspended_from_status_check CHECK (
    suspended_from_status IS NULL OR suspended_from_status IN (
      'intake', 'planning', 'building', 'checking', 'deploying'
    )
  ),
  CONSTRAINT build_runs_suspended_coherence_check CHECK (
    (status = 'suspended') = (suspend_reason IS NOT NULL AND suspended_from_status IS NOT NULL)
  ),
  CONSTRAINT build_runs_revision_counter_check CHECK (
    revision_cap >= 1
    AND current_revision_number >= 1
    AND revisions_used >= 0
    AND revisions_used <= revision_cap
    AND current_revision_number = revisions_used + 1
  ),
  CONSTRAINT build_runs_integration_branch_check CHECK (
    integration_branch IS NULL OR integration_branch = 'apex/build/' || id::text
  ),
  CONSTRAINT build_runs_base_commit_check CHECK (
    base_commit IS NULL OR base_commit ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT build_runs_skill_snapshot_check CHECK (jsonb_typeof(skill_snapshot) = 'object'),
  CONSTRAINT build_runs_support_contacts_check CHECK (
    jsonb_typeof(support_contacts) = 'array' AND jsonb_array_length(support_contacts) >= 1
  ),
  CONSTRAINT build_runs_quality_manifest_snapshot_check CHECK (jsonb_typeof(quality_manifest_snapshot) = 'object'),
  CONSTRAINT build_runs_cost_cap_check CHECK (cost_cap_usd > 0),
  CONSTRAINT build_runs_cost_used_check CHECK (cost_used_usd >= 0),
  CONSTRAINT build_runs_elapsed_cap_check CHECK (elapsed_cap_seconds > 0),
  CONSTRAINT build_runs_parallelism_cap_check CHECK (parallelism_cap BETWEEN 1 AND 6),
  CONSTRAINT build_runs_parallelism_used_check CHECK (parallelism_used BETWEEN 0 AND parallelism_cap),
  CONSTRAINT build_runs_accepted_pr_check CHECK (
    status <> 'accepted' OR (pull_request_url IS NOT NULL AND accepted_revision_number IS NOT NULL)
  ),
  CONSTRAINT build_runs_terminal_ended_at_check CHECK (
    (status IN ('accepted', 'cancelled', 'failed')) = (ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_build_runs_playbook_run ON build_runs (playbook_run_id);
CREATE UNIQUE INDEX uq_build_runs_client_request
  ON build_runs (project, requested_by_user_id, client_request_id);
CREATE INDEX idx_build_runs_project_created ON build_runs (project, created_at DESC);
CREATE INDEX idx_build_runs_slot ON build_runs (project, status)
  WHERE status IN ('intake', 'planning', 'building', 'checking', 'deploying');
CREATE INDEX idx_build_runs_queue ON build_runs (created_at) WHERE status = 'queued';
CREATE INDEX idx_build_runs_cancel_cleanup ON build_runs (ended_at)
  WHERE status = 'cancelled' AND integration_branch_deleted_at IS NULL;
CREATE INDEX idx_build_runs_retention ON build_runs (ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX idx_build_runs_interview ON build_runs (interview_id) WHERE interview_id IS NOT NULL;

CREATE TABLE build_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_run_id UUID NOT NULL,
  revision_number INTEGER NOT NULL,
  feedback TEXT,
  brief_version INTEGER,
  requirements JSONB NOT NULL DEFAULT '[]'::jsonb,
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  classification TEXT,
  plan JSONB,
  plan_validation JSONB,
  context_notes_path TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  elapsed_seconds_used INTEGER NOT NULL DEFAULT 0,
  validated_commit TEXT,
  pipeline_run_id TEXT,
  deployment_status TEXT NOT NULL DEFAULT 'not_started',
  deployment_queued_at TIMESTAMPTZ,
  deployed_at TIMESTAMPTZ,
  deployment_failed_stage TEXT,
  deployment_pipeline_url TEXT,
  preview_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_build_revisions_run FOREIGN KEY (build_run_id) REFERENCES build_runs (id) ON DELETE RESTRICT,
  CONSTRAINT build_revisions_revision_number_check CHECK (revision_number >= 1),
  CONSTRAINT build_revisions_requirements_check CHECK (jsonb_typeof(requirements) = 'array'),
  CONSTRAINT build_revisions_assumptions_check CHECK (jsonb_typeof(assumptions) = 'array'),
  CONSTRAINT build_revisions_exclusions_check CHECK (jsonb_typeof(exclusions) = 'array'),
  CONSTRAINT build_revisions_risk_decisions_check CHECK (jsonb_typeof(risk_decisions) = 'array'),
  CONSTRAINT build_revisions_classification_check CHECK (
    classification IS NULL OR classification IN ('small', 'full')
  ),
  CONSTRAINT build_revisions_plan_check CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
  CONSTRAINT build_revisions_plan_validation_check CHECK (
    plan_validation IS NULL OR jsonb_typeof(plan_validation) = 'object'
  ),
  CONSTRAINT build_revisions_plan_brief_check CHECK (plan IS NULL OR brief_version IS NOT NULL),
  CONSTRAINT build_revisions_repair_attempts_check CHECK (repair_attempts BETWEEN 0 AND 2),
  CONSTRAINT build_revisions_elapsed_seconds_check CHECK (elapsed_seconds_used >= 0),
  CONSTRAINT build_revisions_validated_commit_check CHECK (
    validated_commit IS NULL OR validated_commit ~ '^[0-9a-f]{40}$'
  ),
  CONSTRAINT build_revisions_deployment_status_check CHECK (deployment_status IN (
    'not_started', 'queued', 'deploying', 'succeeded', 'failed'
  )),
  CONSTRAINT build_revisions_deployment_coherence_check CHECK (
    (deployment_status NOT IN ('queued', 'deploying', 'succeeded') OR validated_commit IS NOT NULL)
    AND (deployment_status <> 'succeeded' OR preview_url IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_build_revisions_run_number ON build_revisions (build_run_id, revision_number);
CREATE UNIQUE INDEX uq_build_revisions_pipeline_run ON build_revisions (pipeline_run_id)
  WHERE pipeline_run_id IS NOT NULL;
CREATE INDEX idx_build_revisions_waiting_deploy ON build_revisions (deployment_queued_at, id)
  WHERE deployment_status = 'queued';
CREATE INDEX idx_build_revisions_deploying ON build_revisions (updated_at)
  WHERE deployment_status = 'deploying';

CREATE TABLE build_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_revision_id UUID NOT NULL,
  task_key TEXT NOT NULL,
  role TEXT NOT NULL,
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  owned_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  covers JSONB NOT NULL DEFAULT '[]'::jsonb,
  reuse JSONB NOT NULL DEFAULT '[]'::jsonb,
  run_mode TEXT NOT NULL,
  chain_head_key TEXT,
  branch_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 1,
  omitted_reason TEXT,
  merge_pull_request_id INTEGER,
  merge_commit TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_build_tasks_revision FOREIGN KEY (build_revision_id) REFERENCES build_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT build_tasks_task_key_check CHECK (task_key ~ '^[a-z][a-z0-9-]{0,39}$'),
  CONSTRAINT build_tasks_role_check CHECK (role IN ('planner', 'implementer', 'qa', 'check', 'sync')),
  CONSTRAINT build_tasks_depends_on_check CHECK (jsonb_typeof(depends_on) = 'array'),
  CONSTRAINT build_tasks_owned_files_check CHECK (jsonb_typeof(owned_files) = 'array'),
  CONSTRAINT build_tasks_covers_check CHECK (jsonb_typeof(covers) = 'array'),
  CONSTRAINT build_tasks_reuse_check CHECK (jsonb_typeof(reuse) = 'array'),
  CONSTRAINT build_tasks_run_mode_check CHECK (run_mode IN ('own_agent', 'chain')),
  CONSTRAINT build_tasks_chain_head_key_check CHECK (
    chain_head_key IS NULL OR chain_head_key ~ '^[a-z][a-z0-9-]{0,39}$'
  ),
  CONSTRAINT build_tasks_chain_head_coherence_check CHECK (
    (run_mode = 'own_agent' AND chain_head_key IS NULL)
    OR (run_mode = 'chain' AND chain_head_key IS NOT NULL)
  ),
  CONSTRAINT build_tasks_status_check CHECK (status IN (
    'pending', 'ready', 'running', 'merged', 'failed', 'omitted'
  )),
  CONSTRAINT build_tasks_attempt_check CHECK (attempt >= 1),
  CONSTRAINT build_tasks_omitted_reason_check CHECK ((status = 'omitted') = (omitted_reason IS NOT NULL))
);

CREATE UNIQUE INDEX uq_build_tasks_revision_key ON build_tasks (build_revision_id, task_key);
CREATE INDEX idx_build_tasks_revision_status ON build_tasks (build_revision_id, status);
CREATE UNIQUE INDEX uq_build_tasks_branch_name ON build_tasks (branch_name) WHERE branch_name IS NOT NULL;
CREATE INDEX idx_build_tasks_chain_head ON build_tasks (build_revision_id, chain_head_key)
  WHERE chain_head_key IS NOT NULL;

CREATE TABLE build_verification_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  build_revision_id UUID NOT NULL,
  requirement_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  test_tier TEXT,
  test_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  red_evidence JSONB,
  green_evidence JSONB,
  evidence_blob_ref JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  deferral_reason TEXT,
  carried_from_revision_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_build_verification_rows_revision FOREIGN KEY (build_revision_id) REFERENCES build_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT build_verification_rows_kind_check CHECK (kind IN ('ac', 'dod', 'br', 'nfr', 'risk_decision')),
  CONSTRAINT build_verification_rows_requirement_prefix_check CHECK (
    (kind = 'ac' AND requirement_id ~ '^AC-[1-9][0-9]*$')
    OR (kind = 'dod' AND requirement_id ~ '^DOD-[1-9][0-9]*$')
    OR (kind = 'br' AND requirement_id ~ '^BR-[1-9][0-9]*$')
    OR (kind = 'nfr' AND requirement_id ~ '^NFR-[1-9][0-9]*$')
    OR (kind = 'risk_decision' AND requirement_id ~ '^RD-[1-9][0-9]*$')
  ),
  CONSTRAINT build_verification_rows_test_tier_check CHECK (
    test_tier IS NULL OR test_tier IN ('unit', 'integration', 'e2e')
  ),
  CONSTRAINT build_verification_rows_test_refs_check CHECK (jsonb_typeof(test_refs) = 'array'),
  CONSTRAINT build_verification_rows_red_evidence_check CHECK (
    red_evidence IS NULL OR jsonb_typeof(red_evidence) = 'object'
  ),
  CONSTRAINT build_verification_rows_green_evidence_check CHECK (
    green_evidence IS NULL OR jsonb_typeof(green_evidence) = 'object'
  ),
  CONSTRAINT build_verification_rows_evidence_blob_ref_check CHECK (
    evidence_blob_ref IS NULL OR jsonb_typeof(evidence_blob_ref) = 'object'
  ),
  CONSTRAINT build_verification_rows_status_check CHECK (status IN (
    'pending', 'pass', 'fail', 'deferred', 'retired'
  )),
  CONSTRAINT build_verification_rows_deferral_check CHECK (
    (status = 'deferred') = (deferral_reason IS NOT NULL)
  ),
  CONSTRAINT build_verification_rows_pass_evidence_check CHECK (
    status <> 'pass' OR (
      red_evidence IS NOT NULL
      AND green_evidence IS NOT NULL
      AND jsonb_typeof(test_refs) = 'array'
      AND jsonb_array_length(test_refs) >= 1
    )
  )
);

CREATE UNIQUE INDEX uq_build_verification_rows_revision_requirement
  ON build_verification_rows (build_revision_id, requirement_id);
CREATE INDEX idx_build_verification_rows_revision_status
  ON build_verification_rows (build_revision_id, status);

CREATE TABLE build_preview_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  repository TEXT NOT NULL,
  build_run_id UUID NOT NULL,
  build_revision_id UUID NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT fk_build_preview_leases_run FOREIGN KEY (build_run_id) REFERENCES build_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_build_preview_leases_revision FOREIGN KEY (build_revision_id) REFERENCES build_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT build_preview_leases_project_check CHECK (char_length(project) >= 1 AND project = btrim(project)),
  CONSTRAINT build_preview_leases_repository_check CHECK (char_length(repository) >= 1 AND repository = btrim(repository)),
  CONSTRAINT build_preview_leases_expires_check CHECK (expires_at > granted_at)
);

CREATE UNIQUE INDEX uq_build_preview_leases_project_repository
  ON build_preview_leases (project, repository);
CREATE UNIQUE INDEX uq_build_preview_leases_run ON build_preview_leases (build_run_id);
CREATE INDEX idx_build_preview_leases_expires ON build_preview_leases (expires_at);

CREATE TABLE build_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal BIGSERIAL NOT NULL,
  build_run_id UUID NOT NULL,
  build_revision_id UUID,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  detail JSONB,
  correlation_kind TEXT,
  correlation_id TEXT,
  actor_user_id TEXT,
  dedupe_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_build_events_run FOREIGN KEY (build_run_id) REFERENCES build_runs (id) ON DELETE RESTRICT,
  CONSTRAINT fk_build_events_revision FOREIGN KEY (build_revision_id) REFERENCES build_revisions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_build_events_actor FOREIGN KEY (actor_user_id) REFERENCES app_users (oid) ON DELETE RESTRICT,
  CONSTRAINT build_events_event_type_check CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  CONSTRAINT build_events_severity_check CHECK (severity IN ('info', 'warn', 'error')),
  CONSTRAINT build_events_message_check CHECK (char_length(message) BETWEEN 1 AND 8000),
  CONSTRAINT build_events_detail_check CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
  CONSTRAINT build_events_correlation_kind_check CHECK (
    correlation_kind IS NULL OR correlation_kind IN ('agent_run', 'pipeline_run', 'pull_request', 'commit')
  ),
  CONSTRAINT build_events_correlation_pair_check CHECK (
    (correlation_kind IS NULL) = (correlation_id IS NULL)
  )
);

CREATE UNIQUE INDEX uq_build_events_ordinal ON build_events (ordinal);
CREATE INDEX idx_build_events_run_ordinal ON build_events (build_run_id, ordinal);
CREATE UNIQUE INDEX uq_build_events_dedupe ON build_events (build_run_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE OR REPLACE FUNCTION build_runs_frozen_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.skill_snapshot IS DISTINCT FROM OLD.skill_snapshot
     OR NEW.support_contacts IS DISTINCT FROM OLD.support_contacts
     OR NEW.quality_manifest_snapshot IS DISTINCT FROM OLD.quality_manifest_snapshot
     OR NEW.prompt IS DISTINCT FROM OLD.prompt
     OR NEW.project IS DISTINCT FROM OLD.project
     OR NEW.repository IS DISTINCT FROM OLD.repository
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.playbook_run_id IS DISTINCT FROM OLD.playbook_run_id
  THEN
    RAISE EXCEPTION 'build_runs frozen columns cannot change'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.integration_branch IS NOT NULL
     AND NEW.integration_branch IS DISTINCT FROM OLD.integration_branch
  THEN
    RAISE EXCEPTION 'integration_branch is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.base_commit IS NOT NULL
     AND NEW.base_commit IS DISTINCT FROM OLD.base_commit
  THEN
    RAISE EXCEPTION 'base_commit is write-once'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS build_runs_frozen_columns_guard ON build_runs;
CREATE TRIGGER build_runs_frozen_columns_guard
BEFORE UPDATE ON build_runs
FOR EACH ROW
EXECUTE PROCEDURE build_runs_frozen_columns_guard();

CREATE OR REPLACE FUNCTION build_events_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'build_events rows are append-only'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('apex.build_events_purge', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'build_events rows are append-only'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS build_events_guard ON build_events;
CREATE TRIGGER build_events_guard
BEFORE UPDATE OR DELETE ON build_events
FOR EACH ROW
EXECUTE PROCEDURE build_events_guard();

-- Down Migration

DROP TRIGGER IF EXISTS build_events_guard ON build_events;
DROP FUNCTION IF EXISTS build_events_guard();
DROP TRIGGER IF EXISTS build_runs_frozen_columns_guard ON build_runs;
DROP FUNCTION IF EXISTS build_runs_frozen_columns_guard();

DROP TABLE IF EXISTS build_events;
DROP TABLE IF EXISTS build_preview_leases;
DROP TABLE IF EXISTS build_verification_rows;
DROP TABLE IF EXISTS build_tasks;
DROP TABLE IF EXISTS build_revisions;
DROP TABLE IF EXISTS build_runs;
