# Assumptions & Unresolved Items — Evaluation Data Model and Contracts

> **PRD slug:** `human-workflow-evaluation-for-interviews-and-prds` | **Priority:** Must Have | **Feature flag:** `workflow-human-evaluation`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

This run was non-interactive, so the Phase 2 refinement session did not happen. Each ⚠ item below is a question that session would have raised. Each carries a recommended default so implementation can start on the default if no one answers.

---

## Unresolved Items

Items that could not be inferred from the PRD, backlog, or codebase. Each must be decided before the relevant implementation step starts.

- ⚠ **Registry key vocabulary (Measured Improvement Loop ADR)**: The PRD says registry keys follow the accepted Measured Improvement Loop ADR, with process key `orchestrated_workflow`. A search of the repository at the pinned SHA finds neither the ADR text nor the string `orchestrated_workflow`, so the stage, evaluator and benchmark key values are not confirmed. This blocks S4 (seed migration), because keys written into seed rows become the join keys for every later Feature and cannot be edited in place. **Decision needed:** confirm or replace the proposed values: process `orchestrated_workflow`; stages `prd_human_review`, `interview_phase_1`, `interview_phase_2`, `interview_phase_3`; definition evaluator `human_review`; benchmark `baseline`. **Recommended default:** the proposed values. Job evaluator values (`promptfoo`, `llm_judge`) are a separate vocabulary on `workflow_evaluation_jobs.evaluator_key`, and the ADR owner should confirm that two meanings of "evaluator" are acceptable.

- ⚠ **Source of "skill version"**: Events must store a skill version as a lineage column, but no `skill_version` column, content hash or version counter exists on `prds`, `interviews` or `project_skill_settings` at the pinned SHA. Skills are files in the repository. This blocks FEAT-003's lineage resolver, not the column itself. This Feature stores the value as nullable `TEXT`, so it is safe to build either way. **Decision needed:** state what the string is: the Git commit SHA of the grounded checkout the skill ran against, a hash of the `SKILL.md` content, or a `project_skill_settings` revision. **Recommended default:** the grounded checkout SHA that produced the artifact, because the PRD already carries it as `apex-grounded-sha`.

- ⚠ **Interview phase names and wording**: The PRD seeds three Interview phase stages and says labels and help text differ per stage. It does not name the phases or say how their wording differs. Without product wording, the three Interview seeds can only carry shared Interview wording plus the phase number. This blocks the final copy in S4, not the schema. **Decision needed:** product supplies a name and one-line description for each of phases 1 to 3, and says whether the criteria help text changes per phase. **Recommended default:** ship the shared Interview wording from the design doc's UI/UX section with the phase number in the stage label, then add version 2 rows after the pilot. The versioned seed design makes that a new migration, not an edit.

- ⚠ **Promptfoo suite reference format**: Each seeded definition must carry a Promptfoo suite reference, and the PRD says the first suites are a minimal structural check. No Promptfoo configuration or suite exists in the repository at the pinned SHA, so there is nothing to reference by path. This blocks the value written to `promptfoo_suite_ref` in S4 and the executor Feature that reads it. **Decision needed:** the reference format, and who authors the first suite. **Recommended default:** an opaque string key of the form `orchestrated_workflow/{stage_key}/structural@1`. This Feature stores it as text and never resolves it. The executor Feature maps the key to a suite that App Service puts on the execution specification.

---

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

- **No PBIs, so acceptance criteria come from TBIs**: FEAT-001 contains TBI-001, TBI-002 and TBI-003 only. The four scenarios (happy, error, edge, negative) are written per TBI from its description and `definitionOfDone`. Risk: if a PBI is added later, its criteria must be added to the design doc.

- **Naming**: Tables are `workflow_evaluation_definitions`, `workflow_evaluation_events` and `workflow_evaluation_jobs`. Drizzle exports are `workflowEvaluationDefinitions`, `workflowEvaluationEvents` and `workflowEvaluationJobs`. The shared types file is `src/shared/types/workflowEvaluation.ts`. Derived from repo naming (`playbook_definitions`, `ai_usage_events`, `aiRunV2.ts`). Risk: renaming after the migration applies needs a new migration.

- **`project` is a text column, not an integer id**: The PRD says "project id". `prds.project`, `interviews.project` and `playbook_definitions.project` are all `text`, and the session supplies that same value. Events use `project TEXT NOT NULL` with no foreign key, matching those tables. Risk: none for joins to PRDs and Interviews. A future projects table would need a backfill.

- **Primary keys and timestamps**: All three tables use `uuid` primary keys with `defaultRandom()` and `timestamptz` columns with `mode: 'string'`, per `postgresql-db.mdc` and the `prds` table. Risk: none.

- **Event immutability is enforced in the database as well as the data layer**: The backlog's non-functional requirement says the data access layer exposes no update or delete path. A `BEFORE UPDATE OR DELETE` trigger on the events table adds a second guard, following the precedent in `20260901160000_cloud-agent-run-foundations.sql` (`agent_runs_cloud_agent_identity_immutable`). Test cleanup for the events table must use `TRUNCATE`, because row-level triggers do not fire on it. Risk: a test helper that uses `DELETE FROM` fails.

- **Definitions are immutable except for the `active` flag**: A second trigger rejects any update to a definitions row that changes a column other than `active`. This enforces "a later rubric change adds a new version instead of editing history", and keeps the rubric an event points at the rubric the reviewer saw. Risk: a seed typo cannot be fixed in place and needs a new version row.

- **Interview phase subject**: For subject type `interview_phase`, `subject_id` is the Interview id and `phase_index` (1 to 3) names the phase. For subject type `prd`, `subject_id` is the PRD id and `phase_index` is null. CHECK constraints enforce both pairings and that `prd_id` or `interview_id` equals `subject_id`. Risk: if the product later evaluates a phase that is not an Interview, the subject types need a new value.

- **Lineage columns are nullable**: `skill_path`, `skill_version` and `model` accept null in the database. The service writes them whenever it can resolve them. A lineage gap must not discard a reviewer's feedback, because the feature is advisory. Risk: reports must tolerate null lineage.

- **Corrected artifact has an inline column in addition to the Blob reference**: The backlog lists one optional Blob reference. The PRD says only large corrected artifacts go to Blob, which implies small ones are stored inline. This Feature adds `corrected_artifact_text TEXT` (nullable) beside `corrected_artifact_blob_ref JSONB`. A CHECK allows at most one of the two. The inline size limit is a FEAT-003 service constant. Risk: if product wants every correction in Blob, drop the text column before the migration ships.

- **Blob reference shape**: Blob references are `jsonb` holding the existing `AiRunBlobRef` shape (`{ container, key }`) from `src/shared/types/aiRunV2.ts`, matching `ai_run_attempts.spec_ref`. Risk: none.

- **Criteria scores are stored as one `jsonb` object**: Later processes (Design Docs, Prototypes) reuse the table, so the criteria set cannot be fixed as five columns. The database checks only that the value is a JSON object. The service validates keys and the 1 to 5 range against the definition. The shared type pins the five v1 keys. Risk: the database does not catch a bad score written by a bug outside the service. The trigger and the single repository limit that exposure.

- **Reason codes are a `jsonb` string array**: This follows the repo's `jsonb(...).$type<string[]>()` pattern (for example `prd_approver_ids`). Risk: none.

- **Reviewer FK uses `ON DELETE RESTRICT`**: `reviewer_user_id` references `app_users(oid)`, like `playbook_definitions.created_by`. Events are permanent, so deleting a user who submitted one is refused. Risk: if Apex hard-deletes users, change this to no foreign key and keep the id as text.

- **Event definition link**: `definition_id` references the definition row (which carries process, stage and version) with `ON DELETE RESTRICT`. The event also stores `stage_key` as the PRD requires. The service must set `stage_key` equal to the definition's stage. A CHECK cannot compare across tables. Risk: a service bug could store mismatched keys, so FEAT-003 tests it.

- **Job table additions beyond the PRD list**: Jobs add `error_detail TEXT`, `created_at` and `updated_at`. The admin drawer needs a failure reason, and jobs, unlike events, change state. Risk: none.

- **Manual retry reuses the job row**: The unique pair (event, evaluator) means a retry moves the same row from `failed` to `pending` and replaces `run_id`. Earlier run ids are not kept on the job. Cost per run stays traceable through AI usage events tied to the event id. Risk: if product wants an attempt history, add a child table later.

- **`run_id` links to `agent_runs`**: `workflow_evaluation_jobs.run_id` is nullable `TEXT` referencing `agent_runs(id)` with `ON DELETE SET NULL`, as `playbook_step_runs.agent_run_id` does. It is null until the job passes admission, so an enqueue failure leaves a `pending` job with no run. Risk: if the run reaper deletes old runs, the job loses its run link but keeps its status and summary.

- **Judge output shape**: `WorkflowEvaluationJudgeOutput` has `missedRequirements` and `inventedRequirements` (arrays of `{ description, evidence? }`), optional `alignmentScore` (a number from 1 to 5, so it compares with the human scale), `recommendedImprovements` (array of `{ text, criterion? }`) and `confidence` (`low`, `medium` or `high`). The PRD names the fields but not their inner shape. Risk: the executor Feature may want richer findings, which means a new schema version.

- **Judge schema is generated from one zod schema**: `zod` ^4 is a dependency, and no JSON Schema validator is. The shared module exports a zod schema, and the seeded `judge_output_schema` is the output of `z.toJSONSchema` for it. A parity test pins the two. Runtime validation in later Features uses the zod schema. Risk: a new judge schema version needs a code change as well as a new definitions row.

- **Low-score rule lives in the rubric**: The rubric JSON carries `lowScoreThreshold` (2) and `minLowScoreCommentLength` (20, the PRD's unconfirmed seed value). Changing either is a new definition version. Risk: 20 characters may prove too short or too long in the pilot.

- **Reviewer role keys**: `product_owner`, `ba`, `manager`, `developer`, `qa`, `other`, with the labels from the PRD. QA stays in the list but is not a default grantee. Mapping groups to these keys is FEAT-003's job. Risk: none for this Feature.

- **Hash format only**: The database constrains `artifact_hash` to 64 lowercase hex characters (SHA-256). The hashing algorithm and canonical backlog form belong to the artifact binding resolver in FEAT-003. Risk: if the resolver picks another algorithm, the CHECK must change in a new migration.

- **No generation counter column**: The PRD assumes none exists for PRDs, and none was found for Interviews. The hash alone binds an event to an artifact version. Risk: none.

- **Seeds are idempotent by key**: Definitions are unique on process, stage, evaluator, benchmark and version, and the seed uses `ON CONFLICT DO NOTHING`. A partial unique index allows one active row per process, stage, evaluator and benchmark. A rubric change ships as a new migration that inserts version 2 and sets version 1 inactive. Risk: none.

- **Flag registration is not in this Feature**: TBI-005 (FEAT-002) registers `workflow-human-evaluation`. The three tables exist whether the flag is on or off, and nothing in this Feature runs at request time. Risk: none.

- **Rollback after pilot data exists uses the flag, not `migrate:down`**: The Down migration drops the three tables and deletes the pilot's evaluation events. It is for test databases and pre-release rollback only. Risk: running it in production loses data. The tech spec says so in its rollback section.

- **Integration tests need a real Postgres**: The "applies and rolls back cleanly" criterion needs a database. Existing migration tests such as `playbookInterviewTemplateMigration.test.ts` read the SQL as text. If the CI job has no database, the manual `npm run migrate:local:up` and `migrate:local:down` run is the evidence, recorded in the pull request. Risk: CI would not catch a constraint regression.

- **Feature `route` in the backlog is not used**: FEAT-001 lists `/documents/requirement-mapping`, but it has no screen. The design doc says "Not applicable" for UI and ignores the route. Risk: none.
