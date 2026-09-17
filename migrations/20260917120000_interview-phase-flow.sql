-- Up Migration: FEAT-001 / TBI-001 + FEAT-002 summary/approval columns
-- DoD-0: persist flow selection and phase owner references.
-- DoD-2: existing interviews remain unchanged (all columns nullable, no DEFAULT).
-- FEAT-002: requirements/technical summary + approved_at (nullable; no backfill;
-- summaries stay NULL until first edit, matching createInterview which does not write them).

ALTER TABLE interviews
  ADD COLUMN IF NOT EXISTS phase_flow TEXT,
  ADD COLUMN IF NOT EXISTS requirements_owner_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS technical_owner_id TEXT REFERENCES app_users(oid) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requirements_phase_status TEXT,
  ADD COLUMN IF NOT EXISTS technical_phase_status TEXT,
  ADD COLUMN IF NOT EXISTS requirements_summary TEXT,
  ADD COLUMN IF NOT EXISTS technical_summary TEXT,
  ADD COLUMN IF NOT EXISTS requirements_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS technical_approved_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE interviews
  DROP COLUMN IF EXISTS technical_approved_at,
  DROP COLUMN IF EXISTS requirements_approved_at,
  DROP COLUMN IF EXISTS technical_summary,
  DROP COLUMN IF EXISTS requirements_summary,
  DROP COLUMN IF EXISTS technical_phase_status,
  DROP COLUMN IF EXISTS requirements_phase_status,
  DROP COLUMN IF EXISTS technical_owner_id,
  DROP COLUMN IF EXISTS requirements_owner_id,
  DROP COLUMN IF EXISTS phase_flow;
