-- Soft-blocker escape hatch: authorized users can override a failing design-doc
-- validation score and proceed to approve/review with an audited reason.
-- Shape mirrors PRD readiness_override:
--   { reason, userId, userDisplayName?, at, validationScore, validationThreshold, history: AuditEntry[] }

ALTER TABLE design_docs ADD COLUMN IF NOT EXISTS validation_override JSONB;
