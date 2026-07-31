-- Up Migration

ALTER TABLE pdf_sessions
  ADD COLUMN text_overlays JSONB NOT NULL DEFAULT '[]'::jsonb;
