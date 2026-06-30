-- UP

-- Add group_ids as a JSONB array to support multiple groups per standup config.
-- Keeps group_id column (now nullable) so existing FK constraints are preserved.

ALTER TABLE standup_configs
  ADD COLUMN IF NOT EXISTS group_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Migrate any existing single group_id value into the new array
UPDATE standup_configs
  SET group_ids = jsonb_build_array(group_id::text)
  WHERE group_id IS NOT NULL
    AND group_ids = '[]'::jsonb;

-- Make group_id nullable — it is superseded by group_ids
ALTER TABLE standup_configs
  ALTER COLUMN group_id DROP NOT NULL;

-- Make standup_sessions.group_id nullable too (multi-group sessions belong to config, not one group)
ALTER TABLE standup_sessions
  ALTER COLUMN group_id DROP NOT NULL;
