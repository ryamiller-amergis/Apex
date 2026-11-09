-- Up Migration
-- Normalize project skill settings, rollout step 1 (expand).
-- See design-docs/project-skill-settings-normalization.plan.md.
--
-- One row per (settings_id, workflow). A workflow with no overrides has no row.
-- The legacy per-workflow columns on project_skill_settings are not touched:
-- staging and production share this database, so both slots keep reading them
-- until the contract step.
--
-- The backfill VALUES list must match PROJECT_SKILL_WORKFLOWS in
-- src/shared/constants/projectSkillWorkflows.ts; projectSkillWorkflowSettingsMigration.test.ts
-- checks it. The three ADR workflows each copy the shared adr_model / adr_effort.

CREATE TABLE IF NOT EXISTS project_skill_workflow_settings (
  settings_id UUID NOT NULL REFERENCES project_skill_settings(id) ON DELETE CASCADE,
  workflow TEXT NOT NULL,
  skill_path TEXT,
  model TEXT,
  effort TEXT,
  bedrock_model_id TEXT,
  bedrock_max_tokens INTEGER,
  bedrock_timeout_ms INTEGER,
  bedrock_temperature REAL,
  regen_bedrock_model_id TEXT,
  regen_bedrock_max_tokens INTEGER,
  score_threshold INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (settings_id, workflow)
);

COMMENT ON TABLE project_skill_workflow_settings IS
  'Per-workflow skill path, model, effort, Bedrock, and score settings for a project_skill_settings row. Replaces the legacy per-workflow columns.';

CREATE TEMP VIEW project_skill_workflow_backfill AS
SELECT s.id AS settings_id, s.updated_at, v.*
FROM project_skill_settings s
CROSS JOIN LATERAL (VALUES
    ('interview', s.interview_skill_path, s.interview_model, s.interview_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('prd', s.prd_skill_path, s.prd_model, s.prd_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('adr_interview', s.adr_interview_skill_path, s.adr_model, s.adr_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('adr_finalize', s.adr_finalize_skill_path, s.adr_model, s.adr_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('adr_assistant', s.adr_assistant_skill_path, s.adr_model, s.adr_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('design_doc', s.design_doc_skill_path, s.design_doc_model, s.design_doc_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('design_doc_assistant', s.design_doc_assistant_skill_path, s.design_doc_assistant_model, s.design_doc_assistant_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('design_doc_validation', s.design_doc_validation_skill_path, s.design_doc_validation_model, s.design_doc_validation_effort, NULL, NULL, NULL, NULL, NULL, NULL, s.design_doc_validation_score_threshold),
    ('design_prototype', s.design_prototype_skill_path, s.design_prototype_model, s.design_prototype_effort, s.design_prototype_bedrock_model_id, s.design_prototype_bedrock_max_tokens, s.design_prototype_bedrock_timeout_ms, NULL, s.design_prototype_regen_bedrock_model_id, s.design_prototype_regen_bedrock_max_tokens, NULL),
    ('design_plan', NULL, NULL, NULL, s.design_plan_bedrock_model_id, s.design_plan_bedrock_max_tokens, NULL, NULL, NULL, NULL, NULL),
    ('test_case', s.test_case_skill_path, s.test_case_model, s.test_case_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('prd_assistant', s.prd_assistant_skill_path, s.prd_assistant_model, s.prd_assistant_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('prd_validation', s.prd_validation_skill_path, s.prd_validation_model, s.prd_validation_effort, NULL, NULL, NULL, NULL, NULL, NULL, s.prd_validation_score_threshold),
    ('prd_review', NULL, NULL, NULL, s.prd_review_bedrock_model_id, s.prd_review_bedrock_max_tokens, NULL, NULL, NULL, NULL, NULL),
    ('ui_lab', s.ui_lab_skill_path, NULL, NULL, s.ui_lab_bedrock_model_id, s.ui_lab_bedrock_max_tokens, s.ui_lab_bedrock_timeout_ms, s.ui_lab_bedrock_temperature, s.ui_lab_regen_bedrock_model_id, s.ui_lab_regen_bedrock_max_tokens, NULL),
    ('development', s.development_skill_path, s.development_model, s.development_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('standup', s.standup_skill_path, s.standup_model, s.standup_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('feature_request', s.feature_request_skill_path, s.feature_request_model, s.feature_request_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('technical', s.technical_skill_path, s.technical_model, s.technical_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('issue', s.issue_skill_path, s.issue_model, s.issue_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('calendar_assistant', s.calendar_assistant_skill_path, s.calendar_assistant_model, s.calendar_assistant_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('load_test_generation', s.load_test_generation_skill_path, s.load_test_generation_model, s.load_test_generation_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('design_module', s.design_module_skill_path, s.design_module_model, s.design_module_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('design_module_scoping', s.design_module_scoping_skill_path, s.design_module_scoping_model, s.design_module_scoping_effort, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
) AS v(workflow, skill_path, model, effort, bedrock_model_id, bedrock_max_tokens, bedrock_timeout_ms, bedrock_temperature, regen_bedrock_model_id, regen_bedrock_max_tokens, score_threshold);

-- updated_at copies the parent row's, so the reader treats these rows as current.
INSERT INTO project_skill_workflow_settings (
  settings_id, workflow, skill_path, model, effort, bedrock_model_id, bedrock_max_tokens, bedrock_timeout_ms, bedrock_temperature, regen_bedrock_model_id, regen_bedrock_max_tokens, score_threshold, created_at, updated_at
)
SELECT b.settings_id, b.workflow, b.skill_path, b.model, b.effort, b.bedrock_model_id, b.bedrock_max_tokens, b.bedrock_timeout_ms, b.bedrock_temperature, b.regen_bedrock_model_id, b.regen_bedrock_max_tokens, b.score_threshold, b.updated_at, b.updated_at
FROM project_skill_workflow_backfill b
WHERE num_nonnulls(b.skill_path, b.model, b.effort, b.bedrock_model_id, b.bedrock_max_tokens, b.bedrock_timeout_ms, b.bedrock_temperature, b.regen_bedrock_model_id, b.regen_bedrock_max_tokens, b.score_threshold) > 0
ON CONFLICT (settings_id, workflow) DO NOTHING;

DO $$
DECLARE
  missing_count integer;
  missing_ids text;
BEGIN
  SELECT count(DISTINCT b.settings_id), string_agg(DISTINCT b.settings_id::text, ', ')
    INTO missing_count, missing_ids
  FROM project_skill_workflow_backfill b
  LEFT JOIN project_skill_workflow_settings w
    ON w.settings_id = b.settings_id AND w.workflow = b.workflow
  WHERE num_nonnulls(b.skill_path, b.model, b.effort, b.bedrock_model_id, b.bedrock_max_tokens, b.bedrock_timeout_ms, b.bedrock_temperature, b.regen_bedrock_model_id, b.regen_bedrock_max_tokens, b.score_threshold) > 0
    AND (w.skill_path, w.model, w.effort, w.bedrock_model_id, w.bedrock_max_tokens, w.bedrock_timeout_ms, w.bedrock_temperature, w.regen_bedrock_model_id, w.regen_bedrock_max_tokens, w.score_threshold)
      IS DISTINCT FROM (b.skill_path, b.model, b.effort, b.bedrock_model_id, b.bedrock_max_tokens, b.bedrock_timeout_ms, b.bedrock_temperature, b.regen_bedrock_model_id, b.regen_bedrock_max_tokens, b.score_threshold);

  IF missing_count > 0 THEN
    RAISE WARNING 'project_skill_workflow_settings backfill: % settings row(s) did not copy: %', missing_count, missing_ids;
  ELSE
    RAISE NOTICE 'project_skill_workflow_settings backfill: every workflow value copied';
  END IF;
END $$;

DROP VIEW project_skill_workflow_backfill;

-- Down Migration

DROP TABLE IF EXISTS project_skill_workflow_settings;
