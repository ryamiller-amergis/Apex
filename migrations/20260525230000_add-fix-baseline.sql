-- Add fix_baseline JSONB column to design_docs table
-- Stores a snapshot of the doc content (design, techSpec, assumptions) at the
-- time the user initiates "Fix Validation", so the client can diff changes.
-- Cleared when the user accepts the fixes or reverts.

ALTER TABLE design_docs ADD COLUMN fix_baseline JSONB;
