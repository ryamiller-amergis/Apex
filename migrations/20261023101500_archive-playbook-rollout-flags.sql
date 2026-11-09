-- Up Migration: archive the Playbook rollout flags after the enabled behavior shipped.
-- Project menu visibility and Playbooks role permissions are the remaining gate.
-- Preserve the rows and their audit references; runtime gates have been removed from source.

UPDATE feature_flags
SET lifecycle = 'archived',
    cleanup_ready = true,
    updated_at = now()
WHERE key IN (
  'playbooks-production-adapters',
  'playbooks-authoring-canvas',
  'playbooks-capability-enforcement',
  'playbooks-step-output-artifacts'
);

-- Down Migration

UPDATE feature_flags
SET lifecycle = 'active',
    cleanup_ready = false,
    updated_at = now()
WHERE key IN (
  'playbooks-production-adapters',
  'playbooks-authoring-canvas',
  'playbooks-capability-enforcement',
  'playbooks-step-output-artifacts'
);
