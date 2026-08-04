---
name: apex-skills
description: APEX Foundation Skills CLI wrapper. Use when the user says /apex-skills install, /apex-skills check, /apex-skills update, /apex-skills validate, /apex-skills bootstrap, or /apex-skills doctor. Delegates to the @apex/skills CLI package.
disable-model-invocation: true
---

# APEX Skills CLI Wrapper

Delegates all operations to `npx @apex/skills`. Run the CLI directly for the target repo.

## Commands

```bash
# Verify prerequisites before installing
npx @apex/skills doctor

# Install selected foundations + scaffold adapters (pre-filled from repo scan)
npx @apex/skills install <skill...>
npx @apex/skills install ui-lab to-prd grill-with-docs

# Install all skills
npx @apex/skills install

# Preview what would be written without writing (dry run)
npx @apex/skills install <skill...> --dry-run

# Check for available updates and verify foundation hashes
npx @apex/skills check

# Update foundations to latest (never overwrites adapters)
npx @apex/skills update

# Re-run adapter pre-fill for named skills (or all installed)
npx @apex/skills bootstrap <skill...>

# Show evidence + source for each adapter slot filled
npx @apex/skills bootstrap <skill...> --explain

# Validate catalog coverage, contracts, and lockfile
npx @apex/skills validate
```

## Installed file locations

| Location | Owner | Description |
|----------|-------|-------------|
| `.apex/foundation/<skill>/` | Managed (do not edit) | Immutable foundation from package |
| `.cursor/skills/<skill>/` | Team editable | Project adapter — customize freely |
| `apex-skills.lock.json` | Managed | Version, selected skills, file hashes |

## Cursor slash command invocation

When the user types `/apex-skills <command>`, run the appropriate CLI command above in the terminal. For `install` and `bootstrap`, explain the TODO placeholders the team will need to fill after the command completes.
