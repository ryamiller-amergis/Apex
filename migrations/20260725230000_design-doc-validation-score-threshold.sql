-- Per-project design-doc validation pass threshold (mirrors prd_validation_score_threshold).
ALTER TABLE project_skill_settings
  ADD COLUMN IF NOT EXISTS design_doc_validation_score_threshold INTEGER;
