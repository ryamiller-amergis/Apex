---
name: update-changelog
description: Analyze git changes, bump the semver version, and write changelog entries. Use when the user asks to update the changelog, bump the version, write release notes, or prepare a release.
---

# Update Changelog — Foundation

Analyze local git changes, draft changelog entries, bump the semver version, and update the project's changelog.

## Step 1 — Analyze the changes

```bash
git diff HEAD
git log main..HEAD --oneline
git diff HEAD --name-status
```

Identify:
- New user-facing features
- Improvements to existing behavior
- Bug fixes
- Breaking changes

## Step 2 — Determine the semver bump

| What's in the diff | Bump |
|--------------------|------|
| Any breaking change | **major** (X.0.0) |
| Any new feature, no breaking | **minor** (x.Y.0) |
| Only fixes/improvements | **patch** (x.y.Z) |

Read the current version from the project's changelog file (specified in the project adapter).

## Step 3 — Draft changelog entries

Use these change types:

| Type | Use for |
|------|---------|
| `feature` | New capability |
| `improvement` | Enhancement to existing |
| `bugfix` | Something broken that now works |
| `breaking` | Removed/changed requiring user action |

Write descriptions from a **user perspective** — what can they now do, or what was broken that now works.

## Step 4 — Write the changelog

Prepend the new version entry at the top of the project's changelog file. Do not remove existing entries.

The project adapter specifies:
- The changelog file location and format
- Whether a database migration sync is required
- Any additional release artifacts to update
