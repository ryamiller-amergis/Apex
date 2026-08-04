-- Any coachmark targeting a control inside the Design Module form must be able
-- to reveal that form independently. This is required for direct resume and
-- Back navigation after a page-level step has closed the dialog.

UPDATE walkthrough_anchor_registry
SET
  opener_anchor_keys = '["design-module-add-btn"]'::jsonb,
  updated_by = 'system',
  updated_at = NOW()
WHERE anchor_key IN (
  'design-module-form-modal',
  'design-module-form',
  'design-module-name-input',
  'design-module-slug-preview',
  'design-module-description-input',
  'design-module-icon-select',
  'design-module-search-hints',
  'design-module-suggest-ai',
  'design-module-form-cancel',
  'design-module-save-btn'
)
  AND review_status = 'approved'
  AND is_active = TRUE
  AND deleted_at IS NULL;
