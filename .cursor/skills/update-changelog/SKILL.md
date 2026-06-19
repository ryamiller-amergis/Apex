---
name: update-changelog
description: Update public/CHANGELOG.json and add a migration that syncs the current changelog version into app_settings based on local git changes. Use when the user asks to update the changelog, bump the version, document what changed, write release notes, or prepare a release. Triggers on phrases like "update the changelog", "bump the version", "what changed", "write release notes", or "prepare a release".
---

# Update Changelog

Analyze local git changes, draft changelog entries, bump the semver version, and update the changelog plus the database sync migration.

## Files to update

| File | Purpose |
|------|---------|
| `public/CHANGELOG.json` | Prepend new version entry at the top of the array |
| `migrations/<timestamp>_sync-changelog-version-<version>.sql` | Upsert `app_settings.current_changelog_version` during deployment |

> **Note:** Older docs/scripts may reference a `CURRENT_VERSION` constant in `App.tsx` or `useAppShell.ts`. That constant is no longer part of the live changelog flow. The current release version comes from the top entry in `public/CHANGELOG.json` and is synced to Postgres via migration.

---

## Step 1 — Analyze the changes

Run these commands to understand what has changed:

```bash
# Uncommitted working-tree + staged changes
git diff HEAD

# Commits on this branch not yet on main (if on a feature branch)
git log main..HEAD --oneline

# Summary of touched files
git diff HEAD --name-status
```

Read the output and identify:
- New user-facing features (routes, components, capabilities)
- Improvements to existing behavior
- Bug fixes
- Breaking changes (API changes, data migrations, removed features)

---

## Step 2 — Determine the semver bump

| What's in the diff | Bump |
|--------------------|------|
| Any `breaking` change | **major** (X.0.0) |
| Any new `feature`, no breaking | **minor** (x.Y.0) |
| Only `improvement` / `bugfix` | **patch** (x.y.Z) |

Read the current version from the first entry in `public/CHANGELOG.json`:
```json
[
  {
    "version": "1.25.0"
  }
]
```

Calculate the new version. When in doubt, ask the user to confirm before writing.

---

## Step 3 — Draft the changelog entries

Use the change types below. Write descriptions from a **user perspective** — what can they now do, or what was broken that now works.

| Type | Icon | Use for |
|------|------|---------|
| `feature` | ✨ | New capability the user didn't have before |
| `improvement` | 🚀 | Enhancement to something that already existed |
| `bugfix` | 🐛 | Something broken that now works |
| `breaking` | ⚠️ | Removed/changed something that requires user action |

**Good descriptions:**
- "Added resizable Details Panel with drag-to-resize functionality"
- "What's New modal now opens automatically on first visit after a new release"
- "Fixed issue where tags weren't loading on work items"

**Poor descriptions (reject these):**
- "Fixed bug", "Updated stuff", "Changes"

Group logically related changes into a single entry with a clear `title` (3-6 words describing the release theme).

---

## Step 4 — Write the changelog

### `public/CHANGELOG.json`

Prepend the new entry at position `[0]`. Do **not** remove existing entries.

```json
[
  {
    "version": "<new-version>",
    "date": "<YYYY-MM-DD today>",
    "title": "<release theme, 3-6 words>",
    "changes": [
      { "type": "feature",     "description": "..." },
      { "type": "improvement", "description": "..." },
      { "type": "bugfix",      "description": "..." }
    ]
  },
  ...existing entries...
]
```

## Step 4b — Sync version to database

After writing `public/CHANGELOG.json`, add a migration that updates the server-side `app_settings` row during deployment. This lets the pipeline sync the version without requiring an authenticated admin HTTP session.

Create a migration named like:

```text
migrations/<YYYYMMDDHHMMSS>_sync-changelog-version-<new-version-with-dashes>.sql
```

**Get the filename from the helper — do not guess:**

```bash
node scripts/next-migration-timestamp.mjs sync-changelog-version-<new-version-with-dashes>
# → migrations/20260618140200_sync-changelog-version-1-28-0.sql
```

Create that path and write the SQL into it.

See `.cursor/skills/postgresql-migrations/SKILL.md` for ordering rules. Never rename a changelog sync migration after it has been applied.

Example for version `1.26.0`:

```sql
-- Up Migration

INSERT INTO app_settings (key, value, updated_by, updated_at)
VALUES ('current_changelog_version', '<new-version>', 'system-migration', NOW())
ON CONFLICT (key) DO UPDATE
SET
  value = EXCLUDED.value,
  updated_by = EXCLUDED.updated_by,
  updated_at = EXCLUDED.updated_at;

-- Down Migration

UPDATE app_settings
SET
  value = '<previous-version>',
  updated_by = 'system-migration',
  updated_at = NOW()
WHERE key = 'current_changelog_version'
  AND value = '<new-version>';
```

Use the previous top changelog version for `<previous-version>` so rollback returns the app to the prior release announcement.

---

## Step 5 — Verify

1. Confirm JSON is valid (no trailing commas, correct brackets).
2. Confirm the top `CHANGELOG.json` version matches the migration's `current_changelog_version` value.
3. Confirm the migration down step points back to the previous top changelog version.
4. Tell the user what version was set and show them the drafted entry for approval before writing, if the scope is large or ambiguous.

---

## Handling ambiguous scope

If the diff is large (10+ files) or spans multiple features, ask the user:

> "I see changes across X, Y, and Z. Should I group these into one release entry, or split into separate versions?"

Default: one new version entry per skill invocation unless the user says otherwise.
