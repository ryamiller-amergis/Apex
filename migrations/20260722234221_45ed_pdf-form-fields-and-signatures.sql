-- Add AcroForm text-field values and session-scoped signature state to pdf_sessions.
-- Binary PNG data is stored via pdfArtifactStore (disk/blob) — not in this table.
-- form_field_values: [{fileId, fieldName, value}] — replaces on each autosave.
-- signature_state: {assets: [...], overlays: [...]} — assets reference artifact IDs.

ALTER TABLE pdf_sessions
  ADD COLUMN IF NOT EXISTS form_field_values JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS signature_state JSONB NOT NULL DEFAULT '{"assets":[],"overlays":[]}'::jsonb;
