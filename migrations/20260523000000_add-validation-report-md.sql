-- Add validation_report_md column to design_docs table
-- Stores the human-readable validation scorecard markdown in Postgres
-- instead of reading from the ephemeral workspace filesystem.

ALTER TABLE design_docs ADD COLUMN validation_report_md TEXT;
