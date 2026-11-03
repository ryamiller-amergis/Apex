-- Up Migration
-- Contract project_skill_settings. The expand migration has already copied these
-- columns into project_skill_workflow_settings. Reads and writes use that table.

ALTER TABLE project_skill_settings
  DROP COLUMN IF EXISTS interview_skill_path,
  DROP COLUMN IF EXISTS prd_skill_path,
  DROP COLUMN IF EXISTS adr_interview_skill_path,
  DROP COLUMN IF EXISTS adr_finalize_skill_path,
  DROP COLUMN IF EXISTS adr_assistant_skill_path,
  DROP COLUMN IF EXISTS design_doc_skill_path,
  DROP COLUMN IF EXISTS design_doc_assistant_skill_path,
  DROP COLUMN IF EXISTS design_prototype_skill_path,
  DROP COLUMN IF EXISTS test_case_skill_path,
  DROP COLUMN IF EXISTS interview_model,
  DROP COLUMN IF EXISTS interview_effort,
  DROP COLUMN IF EXISTS prd_model,
  DROP COLUMN IF EXISTS prd_effort,
  DROP COLUMN IF EXISTS adr_model,
  DROP COLUMN IF EXISTS adr_effort,
  DROP COLUMN IF EXISTS design_doc_model,
  DROP COLUMN IF EXISTS design_doc_effort,
  DROP COLUMN IF EXISTS design_doc_assistant_model,
  DROP COLUMN IF EXISTS design_doc_assistant_effort,
  DROP COLUMN IF EXISTS design_prototype_model,
  DROP COLUMN IF EXISTS design_prototype_effort,
  DROP COLUMN IF EXISTS test_case_model,
  DROP COLUMN IF EXISTS test_case_effort,
  DROP COLUMN IF EXISTS design_doc_validation_skill_path,
  DROP COLUMN IF EXISTS design_doc_validation_model,
  DROP COLUMN IF EXISTS design_doc_validation_effort,
  DROP COLUMN IF EXISTS prd_assistant_skill_path,
  DROP COLUMN IF EXISTS prd_assistant_model,
  DROP COLUMN IF EXISTS prd_assistant_effort,
  DROP COLUMN IF EXISTS prd_validation_skill_path,
  DROP COLUMN IF EXISTS prd_validation_model,
  DROP COLUMN IF EXISTS prd_validation_effort,
  DROP COLUMN IF EXISTS prd_review_bedrock_model_id,
  DROP COLUMN IF EXISTS prd_review_bedrock_max_tokens,
  DROP COLUMN IF EXISTS design_prototype_bedrock_model_id,
  DROP COLUMN IF EXISTS design_prototype_bedrock_max_tokens,
  DROP COLUMN IF EXISTS design_prototype_bedrock_timeout_ms,
  DROP COLUMN IF EXISTS design_prototype_regen_bedrock_model_id,
  DROP COLUMN IF EXISTS design_prototype_regen_bedrock_max_tokens,
  DROP COLUMN IF EXISTS design_plan_bedrock_model_id,
  DROP COLUMN IF EXISTS design_plan_bedrock_max_tokens,
  DROP COLUMN IF EXISTS prd_validation_score_threshold,
  DROP COLUMN IF EXISTS design_doc_validation_score_threshold,
  DROP COLUMN IF EXISTS ui_lab_bedrock_model_id,
  DROP COLUMN IF EXISTS ui_lab_bedrock_max_tokens,
  DROP COLUMN IF EXISTS ui_lab_bedrock_timeout_ms,
  DROP COLUMN IF EXISTS ui_lab_regen_bedrock_model_id,
  DROP COLUMN IF EXISTS ui_lab_regen_bedrock_max_tokens,
  DROP COLUMN IF EXISTS ui_lab_bedrock_temperature,
  DROP COLUMN IF EXISTS ui_lab_skill_path,
  DROP COLUMN IF EXISTS development_skill_path,
  DROP COLUMN IF EXISTS development_model,
  DROP COLUMN IF EXISTS development_effort,
  DROP COLUMN IF EXISTS standup_skill_path,
  DROP COLUMN IF EXISTS standup_model,
  DROP COLUMN IF EXISTS standup_effort,
  DROP COLUMN IF EXISTS feature_request_skill_path,
  DROP COLUMN IF EXISTS feature_request_model,
  DROP COLUMN IF EXISTS feature_request_effort,
  DROP COLUMN IF EXISTS technical_skill_path,
  DROP COLUMN IF EXISTS technical_model,
  DROP COLUMN IF EXISTS technical_effort,
  DROP COLUMN IF EXISTS issue_skill_path,
  DROP COLUMN IF EXISTS issue_model,
  DROP COLUMN IF EXISTS issue_effort,
  DROP COLUMN IF EXISTS calendar_assistant_skill_path,
  DROP COLUMN IF EXISTS calendar_assistant_model,
  DROP COLUMN IF EXISTS calendar_assistant_effort,
  DROP COLUMN IF EXISTS load_test_generation_skill_path,
  DROP COLUMN IF EXISTS load_test_generation_model,
  DROP COLUMN IF EXISTS load_test_generation_effort,
  DROP COLUMN IF EXISTS design_module_skill_path,
  DROP COLUMN IF EXISTS design_module_model,
  DROP COLUMN IF EXISTS design_module_effort,
  DROP COLUMN IF EXISTS design_module_scoping_skill_path,
  DROP COLUMN IF EXISTS design_module_scoping_model,
  DROP COLUMN IF EXISTS design_module_scoping_effort;

-- Down Migration

ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS interview_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS adr_interview_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS adr_finalize_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS adr_assistant_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_assistant_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_prototype_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS test_case_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS interview_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS interview_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS adr_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS adr_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_assistant_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_assistant_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_prototype_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_prototype_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS test_case_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS test_case_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_validation_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_validation_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_validation_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_assistant_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_assistant_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_assistant_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_validation_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_validation_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_validation_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_review_bedrock_model_id TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_review_bedrock_max_tokens INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_prototype_bedrock_model_id TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_prototype_bedrock_max_tokens INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_prototype_bedrock_timeout_ms INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_prototype_regen_bedrock_model_id TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_prototype_regen_bedrock_max_tokens INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_plan_bedrock_model_id TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_plan_bedrock_max_tokens INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS prd_validation_score_threshold INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_doc_validation_score_threshold INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS ui_lab_bedrock_model_id TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS ui_lab_bedrock_max_tokens INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS ui_lab_bedrock_timeout_ms INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS ui_lab_regen_bedrock_model_id TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS ui_lab_regen_bedrock_max_tokens INTEGER;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS ui_lab_bedrock_temperature REAL;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS ui_lab_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS development_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS development_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS development_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS standup_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS standup_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS standup_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS feature_request_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS feature_request_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS feature_request_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS technical_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS technical_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS technical_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS issue_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS issue_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS issue_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS calendar_assistant_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS calendar_assistant_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS calendar_assistant_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS load_test_generation_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS load_test_generation_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS load_test_generation_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_module_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_module_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_module_effort TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_module_scoping_skill_path TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_module_scoping_model TEXT;
ALTER TABLE project_skill_settings ADD COLUMN IF NOT EXISTS design_module_scoping_effort TEXT;

UPDATE project_skill_settings AS s SET
  interview_skill_path = w.skill_path,
  interview_model = w.model,
  interview_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'interview';

UPDATE project_skill_settings AS s SET
  prd_skill_path = w.skill_path,
  prd_model = w.model,
  prd_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'prd';

UPDATE project_skill_settings AS s SET
  adr_interview_skill_path = w.skill_path,
  adr_model = w.model,
  adr_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'adr_interview';

UPDATE project_skill_settings AS s SET
  adr_finalize_skill_path = w.skill_path
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'adr_finalize';

UPDATE project_skill_settings AS s SET
  adr_assistant_skill_path = w.skill_path
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'adr_assistant';

UPDATE project_skill_settings AS s SET
  design_doc_skill_path = w.skill_path,
  design_doc_model = w.model,
  design_doc_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'design_doc';

UPDATE project_skill_settings AS s SET
  design_doc_assistant_skill_path = w.skill_path,
  design_doc_assistant_model = w.model,
  design_doc_assistant_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'design_doc_assistant';

UPDATE project_skill_settings AS s SET
  design_doc_validation_skill_path = w.skill_path,
  design_doc_validation_model = w.model,
  design_doc_validation_effort = w.effort,
  design_doc_validation_score_threshold = w.score_threshold
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'design_doc_validation';

UPDATE project_skill_settings AS s SET
  design_prototype_skill_path = w.skill_path,
  design_prototype_model = w.model,
  design_prototype_effort = w.effort,
  design_prototype_bedrock_model_id = w.bedrock_model_id,
  design_prototype_bedrock_max_tokens = w.bedrock_max_tokens,
  design_prototype_bedrock_timeout_ms = w.bedrock_timeout_ms,
  design_prototype_regen_bedrock_model_id = w.regen_bedrock_model_id,
  design_prototype_regen_bedrock_max_tokens = w.regen_bedrock_max_tokens
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'design_prototype';

UPDATE project_skill_settings AS s SET
  design_plan_bedrock_model_id = w.bedrock_model_id,
  design_plan_bedrock_max_tokens = w.bedrock_max_tokens
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'design_plan';

UPDATE project_skill_settings AS s SET
  test_case_skill_path = w.skill_path,
  test_case_model = w.model,
  test_case_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'test_case';

UPDATE project_skill_settings AS s SET
  prd_assistant_skill_path = w.skill_path,
  prd_assistant_model = w.model,
  prd_assistant_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'prd_assistant';

UPDATE project_skill_settings AS s SET
  prd_validation_skill_path = w.skill_path,
  prd_validation_model = w.model,
  prd_validation_effort = w.effort,
  prd_validation_score_threshold = w.score_threshold
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'prd_validation';

UPDATE project_skill_settings AS s SET
  prd_review_bedrock_model_id = w.bedrock_model_id,
  prd_review_bedrock_max_tokens = w.bedrock_max_tokens
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'prd_review';

UPDATE project_skill_settings AS s SET
  ui_lab_skill_path = w.skill_path,
  ui_lab_bedrock_model_id = w.bedrock_model_id,
  ui_lab_bedrock_max_tokens = w.bedrock_max_tokens,
  ui_lab_bedrock_timeout_ms = w.bedrock_timeout_ms,
  ui_lab_bedrock_temperature = w.bedrock_temperature,
  ui_lab_regen_bedrock_model_id = w.regen_bedrock_model_id,
  ui_lab_regen_bedrock_max_tokens = w.regen_bedrock_max_tokens
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'ui_lab';

UPDATE project_skill_settings AS s SET
  development_skill_path = w.skill_path,
  development_model = w.model,
  development_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'development';

UPDATE project_skill_settings AS s SET
  standup_skill_path = w.skill_path,
  standup_model = w.model,
  standup_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'standup';

UPDATE project_skill_settings AS s SET
  feature_request_skill_path = w.skill_path,
  feature_request_model = w.model,
  feature_request_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'feature_request';

UPDATE project_skill_settings AS s SET
  technical_skill_path = w.skill_path,
  technical_model = w.model,
  technical_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'technical';

UPDATE project_skill_settings AS s SET
  issue_skill_path = w.skill_path,
  issue_model = w.model,
  issue_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'issue';

UPDATE project_skill_settings AS s SET
  calendar_assistant_skill_path = w.skill_path,
  calendar_assistant_model = w.model,
  calendar_assistant_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'calendar_assistant';

UPDATE project_skill_settings AS s SET
  load_test_generation_skill_path = w.skill_path,
  load_test_generation_model = w.model,
  load_test_generation_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'load_test_generation';

UPDATE project_skill_settings AS s SET
  design_module_skill_path = w.skill_path,
  design_module_model = w.model,
  design_module_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'design_module';

UPDATE project_skill_settings AS s SET
  design_module_scoping_skill_path = w.skill_path,
  design_module_scoping_model = w.model,
  design_module_scoping_effort = w.effort
FROM project_skill_workflow_settings AS w
WHERE w.settings_id = s.id AND w.workflow = 'design_module_scoping';
