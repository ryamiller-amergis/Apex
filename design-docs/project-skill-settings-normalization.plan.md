# Normalize project skill settings

## Problem

`project_skill_settings` has 110 columns. 77 of them are the same few fields repeated once per AI workflow: a skill path, a model, and an effort level, plus Bedrock and score fields for a few workflows. There are 24 workflows. Each new skill added its fields to the same row, one migration at a time.

Postgres allows 100 arguments in one function call. Drizzle loads a related row by passing every column to `json_build_array`. The standup scheduler did that in `generateDailySessions` and the manual session path (`src/server/services/standupService.ts`, `with: { skillSettings: true }`). Production rejected that query with error 54023 (too many arguments).

The goal is that adding a skill never widens a table again.

## Target shape

Keep one row per project skill configuration for the fields that are set once:

`id`, `project`, `friendly_name`, `is_default`, `skill_provider`, `skill_repo`, `skill_branch`, `default_model`, `default_effort`, `approval_mode`, the Cursor account fields, the `repository_checkout_*` fields, the build profile fields, the prototype and pill settings, and the timestamps. That is 33 columns.

Move each workflow into a child table, `project_skill_workflow_settings`, with one row per `(settings_id, workflow)`:

| Column | Replaces |
| --- | --- |
| `workflow` | the column prefix (`interview`, `prd`, `adr_finalize`, `ui_lab`, `standup`, …) |
| `skill_path` | `*_skill_path` |
| `model`, `effort` | `*_model`, `*_effort` |
| `bedrock_model_id`, `bedrock_max_tokens`, `bedrock_timeout_ms`, `bedrock_temperature` | the `*_bedrock_*` columns |
| `regen_bedrock_model_id`, `regen_bedrock_max_tokens` | the `*_regen_bedrock_*` columns |
| `score_threshold` | the two `*_validation_score_threshold` columns |

A workflow with no overrides has no row. The reader uses `default_model` and `default_effort`.

Three ADR workflows currently share `adr_model` and `adr_effort`. The migration copies those shared values onto each ADR workflow row, so each row can diverge later.

When the rollout finishes, a new skill is one entry in `PROJECT_SKILL_WORKFLOWS` (`src/shared/constants/projectSkillWorkflows.ts`). It needs no migration, no new column, and no new field on `ProjectSkillConfig`.

## Rollout

Staging and production share one database, so the old columns stay until both slots run code that no longer reads them.

1. **Expand.** Add the child table and backfill it from the existing columns. Update `src/server/db/schema.ts` to match the migration.
2. **Keep the API flat.** `projectSettingsService.ts` reads the parent row and the child rows, then maps them back into today's `ProjectSkillConfig`. Routes, `AdminProjectSettings.tsx`, and the AI services stay as they are.
3. **Write both.** For one release, writes update the old columns and the new rows. An older slot can still read the old columns.
4. **Workflows without columns.** Make `legacy` optional on a registry entry, and give each entry a label and the list of fields it uses. Add `workflows: Record<ProjectSkillWorkflowKey, ProjectSkillWorkflowSettings>` to `ProjectSkillConfig` beside the flat fields, plus one helper that resolves a workflow's settings with the `default_model` / `default_effort` fallback. Move each consumer from the flat field to the helper. `AdminProjectSettings.tsx` renders one section per registry entry instead of a hand-written group per skill. From this step on, a new workflow is a registry entry only.
5. **Read the new table only.** Check the backfill report in staging, then stop reading and writing the old columns.
6. **Contract.** After a full production release on step 5, a migration drops the 77 per-workflow columns. `project_skill_settings` goes from 110 to 33 columns. Lower the ceilings in `src/server/__tests__/schemaTableWidth.test.ts` in the same change.
7. **Remove the flat fields.** Delete the per-workflow fields from `ProjectSkillConfig` once no consumer reads them.

**Status.** This pull request delivers steps 1-6. The expand migration copies the old columns into `project_skill_workflow_settings`. `migrations/20261027190000_c4d2_drop-project-skill-workflow-columns.sql` then drops those 77 columns, leaving `project_skill_settings` at 33 columns. Reads and writes use the child table and still return today's flat `ProjectSkillConfig`, so existing screens keep working. A new workflow is a `PROJECT_SKILL_WORKFLOWS` entry. It does not add a column. Step 7, removing the flat fields from the TypeScript type, stays for later. Do not deploy this to production while a slot is still running the previous release: staging and production share the database, and the old code reads the columns this migration drops.

## Keeping the table from growing again

- `src/server/__tests__/schemaTableWidth.test.ts` fails when any table passes 50 columns. It also holds `project_skill_settings` at its current 110 columns and 77 per-workflow columns. Those ceilings may only go down.
- `.cursor/rules/project-skill-settings.mdc` tells agents that a new workflow is a registry entry and never a column, and to select only the columns a relation needs.
- `.cursor/rules/postgresql-db.mdc` adds the general rule: no table above 50 columns, repeated column groups become a child table, and relational includes select their columns.
- `.cursor/skills/kick-off/SKILL.md` points feature design at the registry when a feature needs per-project AI settings.

## Tests

Cover the mapping and the backfill in `projectSettingsService.test.ts`, `apiRoutes.skillConfig.test.ts`, `effortFoundation.test.ts`, `standupService.test.ts`, and the seed data in `src/server/routes/e2eSetup.ts`.

Step 4 adds a test that a registry entry with no `legacy` mapping saves, reloads, and renders in Admin > Project Settings without a migration.

The backfill should report any settings row whose workflow values did not copy.

## Out of scope

No change to config, environment, or infrastructure files. The pool timeout and the MCP Servers page permission check are separate problems.
