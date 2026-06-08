ALTER TABLE design_docs ADD COLUMN IF NOT EXISTS proposed_design_content TEXT;
ALTER TABLE design_docs ADD COLUMN IF NOT EXISTS proposed_tech_spec_content TEXT;
ALTER TABLE design_docs ADD COLUMN IF NOT EXISTS proposed_assumptions_content TEXT;
