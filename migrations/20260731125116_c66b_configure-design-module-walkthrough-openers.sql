-- Configure the existing Design Module walkthrough so advancing from the
-- Add Module coachmark reveals the dialog before the next coachmark resolves.
--
-- Both targets are included so replay/resume can start directly on either the
-- dialog shell step or a subsequent form step.

UPDATE walkthrough_anchor_registry
SET
  opener_anchor_keys = '["design-module-add-btn"]'::jsonb,
  updated_by = 'system',
  updated_at = NOW()
WHERE anchor_key IN ('design-module-form-modal', 'design-module-form')
  AND review_status = 'approved'
  AND is_active = TRUE
  AND deleted_at IS NULL;
