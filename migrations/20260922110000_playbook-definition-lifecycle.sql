-- Up Migration: Playbook definition draft/publish lifecycle storage (FEAT-007 / TBI-030 / TBI-031)
--
-- Phase 0 published versions in place and left delivered definitions without a retained draft.
-- This migration adds draft revision time, an explicit run pin-reason column, backfills one draft
-- per definition that lacks one, and enforces the one-draft invariant with a partial unique index.
--
-- Down drops only the additive columns and the index. Backfilled draft rows are left in place so
-- rollback does not erase working-copy history.

ALTER TABLE playbook_definition_versions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE playbook_runs
  ADD COLUMN IF NOT EXISTS version_pin_reason TEXT;

-- Abort if existing data already violates the one-draft invariant; do not guess which copy to keep.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM playbook_definition_versions
    WHERE status = 'draft'
    GROUP BY definition_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'playbook_definition_lifecycle: one or more definitions have multiple draft versions; resolve before creating uq_playbook_definition_versions_one_draft';
  END IF;
END $$;

-- Backfill one retained draft for every definition that lacks one: copy the highest-numbered
-- version's graph at max(version_number)+1, or an empty graph at version 1 when no versions exist.
INSERT INTO playbook_definition_versions (
  definition_id,
  version_number,
  graph,
  status,
  updated_at
)
SELECT
  d.id,
  COALESCE(
    (
      SELECT MAX(v.version_number)
      FROM playbook_definition_versions v
      WHERE v.definition_id = d.id
    ),
    0
  ) + 1,
  COALESCE(
    (
      SELECT v.graph
      FROM playbook_definition_versions v
      WHERE v.definition_id = d.id
      ORDER BY v.version_number DESC
      LIMIT 1
    ),
    '{"nodes": [], "edges": []}'::jsonb
  ),
  'draft',
  now()
FROM playbook_definitions d
WHERE NOT EXISTS (
  SELECT 1
  FROM playbook_definition_versions v
  WHERE v.definition_id = d.id
    AND v.status = 'draft'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_playbook_definition_versions_one_draft
  ON playbook_definition_versions (definition_id)
  WHERE status = 'draft';

-- Down Migration
--
-- Reversible for the additive columns and the one-draft index only. Do not delete backfilled drafts.

DROP INDEX IF EXISTS uq_playbook_definition_versions_one_draft;

ALTER TABLE playbook_runs
  DROP COLUMN IF EXISTS version_pin_reason;

ALTER TABLE playbook_definition_versions
  DROP COLUMN IF EXISTS updated_at;
