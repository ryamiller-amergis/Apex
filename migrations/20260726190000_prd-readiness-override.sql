-- Soft-blocker escape hatch: authorized users can override specific PRD readiness
-- gap states (e.g. coverage_gaps, validation_failed) and proceed to review.
-- Shape: { reason, userId, at, states: PrdReadinessState[] }

ALTER TABLE prds ADD COLUMN IF NOT EXISTS readiness_override JSONB;
