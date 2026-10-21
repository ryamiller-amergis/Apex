-- Up Migration

INSERT INTO app_settings (key, value, updated_by, updated_at)
VALUES ('current_changelog_version', '1.38.0', 'system-migration', NOW())
ON CONFLICT (key) DO UPDATE
SET
  value = EXCLUDED.value,
  updated_by = EXCLUDED.updated_by,
  updated_at = EXCLUDED.updated_at
WHERE string_to_array(app_settings.value, '.')::int[]
    < string_to_array(EXCLUDED.value, '.')::int[];

-- Down Migration

UPDATE app_settings
SET
  value = '1.37.0',
  updated_by = 'system-migration',
  updated_at = NOW()
WHERE key = 'current_changelog_version'
  AND value = '1.38.0';
