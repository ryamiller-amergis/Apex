---
name: PRD Spec Review
overview: Add PRD spec review validation that runs automatically after all three artifacts are created (PRD + backlog + test cases), following the same flow as design doc validation (score, report, fix with AI, approve/reject). Validation badge shows "Validation unavailable" while artifacts are pending, a running indicator while validation is in progress, green on pass, and red on error. Extract shared validation infrastructure so both document types use common logic.
todos:
  - id: phase-1-migration
    content: "Phase 1: Create DB migration — validation columns on prds, prd_validation_skill_path/model on project_skill_settings; update schema.ts"
    status: pending
  - id: phase-1-shared-types
    content: "Phase 1: Update shared types — validating PrdStatus, PRD validation fields, prdValidationSkillPath/Model on ProjectSkillConfig"
    status: pending
  - id: phase-2-shared-service
    content: "Phase 2: Create documentValidationService.ts — adapter pattern for auto-start, watcher, sync, cancel"
    status: pending
  - id: phase-2-prd-adapter
    content: "Phase 2: PRD validation in prdService — artifact-readiness gate (PRD + backlog + test cases), adapter, watcher dual-sync, chatAgentService, startupRecovery, fix flow"
    status: pending
  - id: phase-2-design-doc-refactor
    content: "Phase 2: Refactor designDocService.ts to delegate to documentValidationService.ts"
    status: pending
  - id: phase-3-routes
    content: "Phase 3: Add PRD validation routes to interviews.ts and wire projectSettingsService/admin.ts"
    status: pending
  - id: phase-3-hooks
    content: "Phase 3: Add PRD validation hooks to useInterviews.ts"
    status: pending
  - id: phase-4-prd-review-ui
    content: "Phase 4: Add validation UX to PrdReviewView.tsx — unavailable/running/green/red badge, tab, banner, fix flow"
    status: pending
  - id: phase-4-admin-settings
    content: "Phase 4: Wire prdValidationSkillPath/Model in AdminProjectSettings.tsx"
    status: pending
  - id: phase-4-css
    content: "Phase 4: Add validation CSS to PrdReviewView.module.css — unavailable, running, passed, error states"
    status: pending
isProject: false
---

# PRD Spec Review

## Current State

PRDs have no validation step. After generation, a PRD goes directly to `pending_review`. There is no quality gate, no scorecard, and no automated spec review before human approval.

Design docs already have a full validation pipeline via `designDocService.ts`: auto-start validation thread, watcher polling for `review-scorecard.json`, sync to DB, validation report tab, fix-with-Apex flow, and a 90% approval gate. The PRD flow should mirror this using the external `prd-spec-review` skill (configured per project).

## Architecture

Validation is **gated on all three artifacts being ready**: the PRD content, the backlog JSON, and the test cases. Validation cannot start until all three exist. The badge reflects readiness and execution state at all times.

```mermaid
flowchart TD
    subgraph artifacts [Artifact Readiness Gate]
        PrdReady["PRD content ready"]
        BacklogReady["Backlog JSON created"]
        TestsReady["Test cases created"]
        Gate{"All three ready?"}
    end

    subgraph trigger [Trigger]
        ArtifactDone["Artifact completion event\n(syncOutputToDb / test case save)"]
        ManualRun["User Run Validation"]
    end

    subgraph validation [Shared Validation Engine]
        AutoStart["autoStartDocumentValidation()"]
        Watcher["startDocumentValidationWatcher()"]
        Sync["syncDocumentValidationResult()"]
    end

    subgraph fix [Fix Flow]
        TriggerFix["triggerFixPrdValidation()"]
        Review["FixValidationPanel"]
    end

    subgraph badge [Validation Badge UI]
        Unavailable["Validation unavailable\n(gray — artifacts pending)"]
        Running["Running\n(spinner — validation in progress)"]
        Passed["Passed\n(green — score ≥ 90)"]
        Failed["Error\n(red — score < 90 or run error)"]
    end

    PrdReady --> Gate
    BacklogReady --> Gate
    TestsReady --> Gate
    Gate -->|"No"| Unavailable
    Gate -->|"Yes"| ArtifactDone
    ArtifactDone --> AutoStart
    ManualRun -->|"All artifacts ready"| AutoStart
    AutoStart --> Running
    AutoStart --> Watcher
    Watcher --> Sync
    Sync -->|"score ≥ 90"| Passed
    Sync -->|"score < 90"| Failed
    Sync -->|"score < 90"| TriggerFix
    TriggerFix --> Review
    Review -->|"Accept"| AutoStart
```

## Database Schema

Migration: `npm run migrate:create -- prd-validation`

**`prds`** — add columns:
- `validation_thread_id` UUID
- `validation_score` INTEGER
- `validation_scorecard` JSONB
- `validation_report_md` TEXT
- `validation_phase` TEXT
- `fix_baseline` JSONB

**`project_skill_settings`** — add columns:
- `prd_validation_skill_path` TEXT
- `prd_validation_model` TEXT

Update `src/server/db/schema.ts` to match.

## Server Changes

### Service: `src/server/services/documentValidationService.ts` (new)

Adapter-based shared validation: `autoStartDocumentValidation`, `startDocumentValidationWatcher`, `syncDocumentValidationResult`, `cancelDocumentValidation`, `generateFallbackReport`.

### Service: `src/server/services/prdService.ts`

- `autoStartPrdValidation`, `cancelPrdValidation`, `syncPrdValidationResult`
- `triggerFixPrdValidation`, `acceptFixPrdValidation`
- Add `arePrdValidationArtifactsReady(prdId)` — returns `true` only when PRD content, backlog JSON, and test cases all exist for the interview
- Update `startPrdWatcher` and `syncPrdContent` to call `arePrdValidationArtifactsReady` before routing to `validating`; if not ready, remain in `draft` / `pending_review` without starting validation

### Service: `src/server/services/testCaseService.ts`

After saving test cases, call `arePrdValidationArtifactsReady` and, if true, invoke `autoStartPrdValidation`. This is the final artifact that unblocks validation in the normal generation flow.

### Service: `src/server/services/chatAgentService.ts`

Post-run `syncOutputToDb` must also trigger PRD validation when applicable (dual sync path). After syncing backlog output, call `arePrdValidationArtifactsReady` — if all artifacts are now ready, start validation.

### Service: `src/server/services/startupRecovery.ts`

Re-hydrate PRD validation watchers for PRDs stuck in `validating`.

### Service: `src/server/services/projectSettingsService.ts`

Add `prdValidationSkillPath` / `prdValidationModel` to `upsertSkillConfig`.

### Routes: `src/server/routes/interviews.ts`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/interviews/prds/:prdId/validation-thread` | Start/re-run validation |
| POST | `/api/interviews/prds/:prdId/validation/cancel` | Cancel validation |
| POST | `/api/interviews/prds/:prdId/validation/refresh` | Sync scorecard |
| GET | `/api/interviews/prds/:prdId/validation/report` | Get report markdown |
| POST | `/api/interviews/prds/:prdId/validation/mark-ready` | Mark ready (score >= 90) |
| POST | `/api/interviews/prds/:prdId/fix-validation` | Trigger AI fix |
| POST | `/api/interviews/prds/:prdId/fix-validation/accept` | Accept fix + re-validate |
| PATCH | `/api/interviews/prds/:prdId/revert-section` | Revert to baseline |

Mirror design doc validation route patterns in the same file.

## Client Changes

### Types: `src/shared/types/interview.ts`, `projectSettings.ts`

Add `validating` to `PrdStatus`; validation fields on PRD types; `prdValidationSkillPath`/`prdValidationModel` on config types.

### Hooks: `src/client/hooks/useInterviews.ts`

Mirror design doc validation hooks for PRDs.

### Components

- `PrdReviewView.tsx` — validation badge, tab, banner, fix flow (mirror `DesignDocReviewView.tsx`)
  - Badge renders one of four states driven by `PrdStatus` + `validation_score`:
    - **Unavailable** (gray, static) — shown when PRD, backlog, or test cases are not yet all created; label "Validation unavailable"
    - **Running** (animated spinner) — shown while `prdStatus === 'validating'`; label "Running"
    - **Passed** (green) — shown when validation completes with `score >= 90`
    - **Error** (red) — shown when validation completes with `score < 90` or a thread-level error occurred
  - Manual "Run Validation" button is enabled only when all artifacts are ready and status is not already `validating`
- `PrdReviewView.module.css` — validation styles for all four badge states: `.badgeUnavailable`, `.badgeRunning`, `.badgePassed`, `.badgeError`
- `AdminProjectSettings.tsx` — PRD Validation Skill + Model in Process Skills / Model Overrides accordions

## Key Design Decisions

1. **Shared validation service** — adapter pattern avoids duplicating watcher/sync/fix logic.
2. **Same `ValidationScorecard` type** — PRD dimensions map to `features[]` entries (PRD markdown, backlog JSON, test cases).
3. **All-artifact gate before `validating`** — validation only starts when PRD content, backlog JSON, and test cases are all present. The status flow is: `generating` → `draft` (artifacts accumulating) → `validating` (all three ready) → `draft` | `pending_review`. Without the gate, partial artifacts would produce meaningless validation scores.
4. **Test case save is the final trigger** — in the normal generation flow, test cases are the last artifact created. `testCaseService.ts` checks readiness after each save and fires `autoStartPrdValidation` when the gate opens.
5. **Validation badge states** — four explicit states drive the UI badge:
   - `unavailable` (gray) — artifacts are not all ready yet; badge reads "Validation unavailable"
   - `running` (spinner/animated) — validation thread is active; badge reads "Running"
   - `passed` (green) — score ≥ 90; badge reads "Passed"
   - `error` (red) — score < 90 or thread error; badge reads "Error"
6. **Optional per project** — no `prdValidationSkillPath` → badge is hidden entirely; skip to `pending_review`.
7. **Fix flow uses `prdAssistantThreadId`** and existing `update_prd` MCP tool.
8. **Admin settings** — `prdValidationSkillPath` in Process Skills; `prdValidationModel` in Model Overrides (same pattern as design doc validation).

## Phase Summary and Parallelization

```mermaid
flowchart LR
    P1["Phase 1<br/>DB + Types"]
    P2["Phase 2<br/>Services"]
    P3["Phase 3<br/>Routes + Hooks"]
    P4["Phase 4<br/>Client UI"]

    P1 --> P2
    P2 --> P3
    P3 --> P4
```

- **Phase 1** (2 tasks, parallel): migration + shared types.
- **Phase 2** (3 tasks, parallel): shared service first is ideal but prd adapter can stub until shared service lands; design doc refactor depends on shared service existing.
- **Phase 3** (2 tasks, parallel): routes + hooks after Phase 2.
- **Phase 4** (3 tasks, parallel): UI, admin settings, CSS after Phase 3.

## Files Changed / Created

| Action | Path |
|--------|------|
| Create | `migrations/*_prd-validation.sql` |
| Create | `src/server/services/documentValidationService.ts` |
| Create | `src/server/__tests__/documentValidationService.test.ts` |
| Create | `src/server/__tests__/prdValidationFlow.test.ts` |
| Modify | `src/server/db/schema.ts` |
| Modify | `src/server/services/prdService.ts` |
| Modify | `src/server/services/designDocService.ts` |
| Modify | `src/server/services/chatAgentService.ts` |
| Modify | `src/server/services/startupRecovery.ts` |
| Modify | `src/server/services/projectSettingsService.ts` |
| Modify | `src/server/routes/interviews.ts` |
| Modify | `src/server/routes/admin.ts` |
| Modify | `src/shared/types/interview.ts` |
| Modify | `src/shared/types/projectSettings.ts` |
| Modify | `src/client/hooks/useInterviews.ts` |
| Modify | `src/client/components/PrdReviewView.tsx` |
| Modify | `src/client/components/PrdReviewView.module.css` |
| Modify | `src/client/components/AdminProjectSettings.tsx` |
