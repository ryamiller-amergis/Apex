# Normalize project skill settings

## Problem

`project_skill_settings` has 107 columns. Most of them are the same three fields repeated once per AI workflow: a skill path, a model, and an effort level, plus a handful of Bedrock and score fields for a few workflows.

Postgres allows 100 arguments in one function call. Drizzle loads a related row by passing every column to `json_build_array`. The standup scheduler does that in `generateDailySessions` and the manual session path (`src/server/services/standupService.ts`, `with: { skillSettings: true }`). Production rejects that query with error 54023 (too many arguments). The scheduler only needs `standup_skill_path`, `skill_repo`, and `skill_branch`.

Adding the next skill today means another migration and three more columns. The table will keep growing past the limit.

## Target shape

Keep one row per project skill configuration for the fields that are set once:

`id`, `project`, `friendly_name`, `is_default`, `skill_provider`, `skill_repo`, `skill_branch`, `default_model`, `default_effort`, `approval_mode`, the Cursor account fields, the `repository_checkout_*` fields, the prototype and pill settings, and the timestamps. That is about 30 columns.

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

After this, a new skill is a new value in a shared workflow list. It does not need a migration.

## Rollout

Staging and production share one database, so the old columns stay until both slots run the new code.

1. **Expand.** Add the child table and backfill it from the existing columns. Update `src/server/db/schema.ts` to match the migration.
2. **Keep the API flat.** `projectSettingsService.ts` reads the parent row and the child rows, then maps them back into today's `ProjectSkillConfig`. Routes, `AdminProjectSettings.tsx`, and the AI services stay as they are.
3. **Write both.** For one release, writes update the old columns and the new rows. An older slot can still read the old columns.
4. **Read the new table only.** Compare copied values in staging, then stop writing the old columns.
5. **Contract.** After a full production release, a later migration drops the old columns.

**Status.** Steps 1-3 are delivered together: `migrations/20261027180000_c4d2_project-skill-workflow-settings.sql` adds `project_skill_workflow_settings` and backfills it, `src/shared/constants/projectSkillWorkflows.ts` lists the workflows that the backfill, the read mapping and the dual write share, and `src/server/services/projectSkillWorkflowSettings.ts` holds the mapping. Reads use a child row only when its `updated_at` is not older than the parent row's, so a slot that writes only the old columns is never shadowed by stale child rows. Steps 4 and 5 are not started.

## Immediate follow-up, separate from this redesign

`standupService.ts` should select only `standupSkillPath`, `skillRepo`, and `skillBranch` instead of `skillSettings: true`. That makes the failing query legal without waiting for the table split. It is a small change and can ship on its own. This plan does not include that edit.

## Later, optional

Replace the flat fields on `ProjectSkillConfig` with `workflows: Record<WorkflowKey, WorkflowSettings>`. `AdminProjectSettings.tsx` can then render one section per workflow from the shared list instead of a hand-written group per skill.

## Tests

Cover the mapping and the backfill in `projectSettingsService.test.ts`, `apiRoutes.skillConfig.test.ts`, `effortFoundation.test.ts`, `standupService.test.ts`, and the seed data in `src/server/routes/e2eSetup.ts`.

The backfill should report any settings row whose workflow values did not copy.

## Out of scope

No change to config, environment, or infrastructure files. The pool timeout and the MCP Servers page permission check are separate problems.
