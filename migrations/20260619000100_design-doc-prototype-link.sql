-- Add design_prototype_id and feature_index to design_docs for 1:1 FK link
-- to the specific prototype feature that generated this design doc.

ALTER TABLE design_docs
  ADD COLUMN IF NOT EXISTS design_prototype_id UUID REFERENCES design_prototypes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS feature_index INTEGER;

-- Partial unique index: at most one design doc per (prototype, feature_index) pair.
-- The WHERE clause limits enforcement to prototype-linked rows only so that
-- manually created docs (no prototype link) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_design_docs_prototype_feature
  ON design_docs (design_prototype_id, feature_index)
  WHERE design_prototype_id IS NOT NULL;
