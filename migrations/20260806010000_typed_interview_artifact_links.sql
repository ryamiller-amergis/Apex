-- Up Migration
-- Typed Interview → ADR / Design Module grounding links (FEAT-001 / TBI-001).

CREATE TABLE interview_adr_links (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id  UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  adr_id        UUID        NOT NULL REFERENCES adrs(id) ON DELETE CASCADE,
  linked_by     TEXT        NOT NULL,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_interview_adr_links_interview_adr UNIQUE (interview_id, adr_id)
);

CREATE INDEX idx_interview_adr_links_interview_id ON interview_adr_links (interview_id);

CREATE TABLE interview_design_module_links (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id      UUID        NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  design_module_id  UUID        NOT NULL REFERENCES design_modules(id) ON DELETE CASCADE,
  linked_by         TEXT        NOT NULL,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_interview_design_module_links_interview_module UNIQUE (interview_id, design_module_id)
);

CREATE INDEX idx_interview_design_module_links_interview_id ON interview_design_module_links (interview_id);

-- Down Migration

DROP TABLE IF EXISTS interview_design_module_links;
DROP TABLE IF EXISTS interview_adr_links;
