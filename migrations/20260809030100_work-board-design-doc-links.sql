-- Link board work items to Apex design docs / prototypes (mirrors ADO Feature attachments).

ALTER TABLE apex_work_items
  ADD COLUMN IF NOT EXISTS design_doc_id UUID REFERENCES design_docs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS design_prototype_id UUID REFERENCES design_prototypes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_apex_work_items_design_doc
  ON apex_work_items (design_doc_id)
  WHERE design_doc_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_apex_work_items_design_prototype
  ON apex_work_items (design_prototype_id)
  WHERE design_prototype_id IS NOT NULL;

-- DOWN
-- DROP INDEX IF EXISTS idx_apex_work_items_design_prototype;
-- DROP INDEX IF EXISTS idx_apex_work_items_design_doc;
-- ALTER TABLE apex_work_items DROP COLUMN IF EXISTS design_prototype_id;
-- ALTER TABLE apex_work_items DROP COLUMN IF EXISTS design_doc_id;
