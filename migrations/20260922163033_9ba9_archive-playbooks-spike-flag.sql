-- Up Migration: archive the retired playbooks-spike flag after Phase 1 acceptance.
-- Preserve the row and its audit references; runtime gates have been removed from source.

UPDATE feature_flags
SET lifecycle = 'archived',
    cleanup_ready = true,
    updated_at = now()
WHERE key = 'playbooks-spike';

-- Down Migration

UPDATE feature_flags
SET lifecycle = 'active',
    cleanup_ready = false,
    updated_at = now()
WHERE key = 'playbooks-spike';
