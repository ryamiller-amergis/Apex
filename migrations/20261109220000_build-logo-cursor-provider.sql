-- Replace the ComfyUI runtime with Cursor-generated SVG candidates while
-- retaining historical ComfyUI batch rows. Link an approved candidate to the
-- exact revision that applies it.

-- Up Migration

ALTER TABLE build_logo_candidate_batches
  DROP CONSTRAINT build_logo_candidate_batches_provider_check;

ALTER TABLE build_logo_candidate_batches
  ADD CONSTRAINT build_logo_candidate_batches_provider_check
  CHECK (provider IN ('comfyui', 'cursor_svg'));

ALTER TABLE build_revisions
  ADD COLUMN approved_logo_candidate_id UUID
  REFERENCES build_logo_candidates (id) ON DELETE RESTRICT;

-- Down Migration

ALTER TABLE build_revisions
  DROP COLUMN IF EXISTS approved_logo_candidate_id;

ALTER TABLE build_logo_candidate_batches
  DROP CONSTRAINT build_logo_candidate_batches_provider_check;

ALTER TABLE build_logo_candidate_batches
  ADD CONSTRAINT build_logo_candidate_batches_provider_check
  CHECK (provider IN ('comfyui'));
