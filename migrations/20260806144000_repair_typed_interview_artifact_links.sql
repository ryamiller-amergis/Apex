-- Up Migration
-- The original migration used a malformed DOWN marker, so node-pg-migrate
-- executed its DROP statements during UP. Restore the intended schema
-- idempotently for databases that already recorded that migration.

CREATE TABLE IF NOT EXISTS interview_adr_links (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id  UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  adr_id        UUID        NOT NULL REFERENCES adrs(id) ON DELETE CASCADE,
  linked_by     TEXT        NOT NULL,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_interview_adr_links_interview_adr UNIQUE (interview_id, adr_id)
);

CREATE INDEX IF NOT EXISTS idx_interview_adr_links_interview_id
  ON interview_adr_links (interview_id);

CREATE TABLE IF NOT EXISTS interview_design_module_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id      UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  design_module_id  UUID        NOT NULL REFERENCES design_modules(id) ON DELETE CASCADE,
  linked_by         TEXT        NOT NULL,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_interview_design_module_links_interview_module UNIQUE (interview_id, design_module_id)
);

CREATE INDEX IF NOT EXISTS idx_interview_design_module_links_interview_id
  ON interview_design_module_links (interview_id);

-- Down Migration

-- The original migration owns these tables. Rolling back only this repair must
-- not remove schema that the original migration still declares as applied.
SELECT 1;
