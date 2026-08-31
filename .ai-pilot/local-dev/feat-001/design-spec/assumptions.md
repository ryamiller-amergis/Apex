# Pipeline Status Dashboard — Assumptions

**PRD slug:** `status-driven-agent-home`
**Feature:** Pipeline Status Dashboard (`FEAT-001`)
**Priority:** Must Have
**Feature flag:** None. The epic adds no flag of its own — the existing `agent-home` flag (paired with `home:view`) keeps gating all of `/home`, unchanged.
**Linked artifacts:** [`design-doc-design.md`](./design-doc-design.md) · [`design-doc-tech-spec.md`](./design-doc-tech-spec.md)

This feature was generated non-interactively. The interview transcript (Q1–Q37) already resolved most open decisions with an explicit recommended default; those are recorded below as **Assumptions Accepted**. The items in **Unresolved Items** are gaps the interview did not cover, surfaced during repository grounding (schema, RBAC catalog, and existing service inspection) — each has a recommended default so implementation is not blocked, but needs explicit developer sign-off before TBI-002, TBI-003, and TBI-004 are built.

---

## Unresolved Items

### ⚠ U-1 — Frozen done-event timestamp: storage shape and backfill for already-completed artifacts

**Question:** TBI-002 requires a done-event timestamp that is captured once, at the moment of transition, and never moves on a later edit. Today, `interviews`, `prds`, `design_prototypes`, `design_docs`, and `test_cases` only carry `created_at`/`updated_at`, and the one candidate "approval" timestamp — `documentOwnerApprovals.respondedAt` — is written with `onConflictDoUpdate` keyed on `(documentId, documentType)`, so a second approval response (e.g. after a revision cycle) silently overwrites the first. None of the existing columns are safe to read directly as the frozen event.

The tech spec (§5) proposes a new, insert-once `artifact_done_events` table populated at each existing transition call site (interview Mark Complete, `recordOwnerApproval` when status becomes `approved`, test-case suite reaching `ready`). That table has no rows for artifacts that already reached their done state before this migration ships.

**Impact:** Any artifact that completed before the migration but is still inside the trailing 90-day cycle-time window at ship time has no captured event and is either excluded from the median or must be backfilled from an approximate timestamp (`updated_at` / `reviewed_at` / the last `documentOwnerApprovals.respondedAt`), which is not necessarily the true original done moment.

**Recommended default:** Do **not** backfill. Treat every artifact completed before the migration's deploy timestamp as outside the cycle-time population. This under-counts the first 90 days after ship (the "zero completions" empty state per PBI-002 AC3 may show longer than expected) but never reports a fabricated number.

**Decision needed:** Confirm "no backfill" is acceptable, or specify which approximate source column to backfill from and accept the resulting inaccuracy.

### ⚠ U-2 — "First developer start" instant for Apex-native sessions vs. ADO items

**Question:** BR-010 defines the cycle-time start as "My Work session start, or Azure DevOps In Progress/Active." For Apex-native features, `devSessions.createdAt` is written the instant a user clicks Start Development/Start Local — before `dependencyBootstrapService` finishes cloud workspace setup for the cloud path. For ADO items, the equivalent instant is a revision-history state transition to `In Progress`/`Active`, which happens only after the user (or an automated cascade) changes the work item state. These are not the same kind of event: one is a click, the other is a state transition that can lag the click.

**Impact:** Once Apex and ADO integrate (per the PRD's own stated near-term plan), a single project-wide median mixing click-time starts and transition-time starts is not apples-to-apples, and a slow cloud bootstrap does not inflate the Apex-native number the way a delayed `In Progress` transition would inflate the ADO number.

**Recommended default:** Use `devSessions.createdAt` (click-time) uniformly for Apex-native items, since it is the only start-of-intent timestamp that exists today without adding a session-status-history table.

**Decision needed:** Confirm click-time is acceptable, or require a new `dev_session_status_history` table so Apex-native start can be redefined later as "first transition to `in_progress`" without another migration.

### ⚠ U-3 — Open Bugs on PBIs: project total vs. the 20-row display cap

**Question:** PBI-004's AC requires both "up to 20 rows" and "a project total." TBI-004's bug lookup mirrors the existing `getAIWorkItemHealthMetrics` pattern in `azureDevOps.ts` (`WorkItemExpand.Relations` per PBI, filtered to `System.LinkTypes.Hierarchy-Forward` children of type Bug) — an O(n) ADO call per PBI. For a backlog with hundreds of PBIs, computing an exact project total this way risks the 5-second P95 budget (TBI-001, PBI-004 NFR).

**Impact:** Either the project total is exact but occasionally slow, or it is fast but approximate.

**Recommended default:** Compute the project total from a single un-scoped WIQL query (`SELECT [System.Id] ... WHERE [System.WorkItemType] = 'Bug' AND [System.State] NOT IN (...)` intersected with "has a PBI parent"), and compute the per-PBI breakdown only for the top 20 PBIs by open-bug count. The total is exact; only the row-level detail is capped.

**Decision needed:** Confirm this split (exact total, capped detail) matches the intended reading of the AC, since the sum of the 20 displayed rows will not always equal the displayed total when more than 20 PBIs have open bugs.

### ⚠ U-4 — Source of truth for "Design Prototypes disabled for the current project" (BR-005)

**Question:** BR-005 hides the Prototype pipeline group and cycle-time KPI when prototypes are disabled "for the current project." The only existing flag is `interviews.prototypeStageEnabled`, a per-Interview boolean (default `true`) — there is no project-level setting today.

**Impact:** A project can contain Interviews with different `prototypeStageEnabled` values, so "disabled for the project" has no single source row to read.

**Recommended default:** Treat Prototypes as enabled for the project if **any** Interview in the current project has `prototypeStageEnabled = true`; hide the group/KPI only when every Interview in the project has it set to `false` (including the case of zero Interviews, which hides it by the same rule the Incomplete Pipeline tile already uses for zero data).

**Decision needed:** Confirm this project-wide "any true wins" reading, or specify a real project-level setting (would add a column to `projectSettingsService`'s table, out of scope for this Feature unless called for explicitly).

---

## Assumptions Accepted

- **Full-stack surface, tile-by-tile permission hiding, no new permission, default NFRs.** 2s P95 for Apex-local tiles, 5s P95 for ADO/Releases-backed tiles, 100 concurrent Home loads, 20 rows per tile, no new feature flag (interview Q1–Q5).
- **Incomplete Pipeline stall rules (BR-001 through BR-006, BR-011, BR-012).** A Mark-Complete Interview stays listed until a PRD exists; a PRD/Prototype/Design Doc stays listed until **owner final approval** (reviewer-only approval keeps it listed); a Test Case row appears only when `testCasesEnabled` is true and status is not `ready`; an owner-approved Prototype stays listed until a Design Doc row exists for that feature; rows sort oldest-`updated_at`-first, capped at 20 per group, with a project total and "View all"; the whole tile is hidden without `interviews:view` **and** Interview menu visibility (`enabledViews.includes('backlog')`), Super Admin excepted (Q6, Q14, Q15, Q19, Q26, Q27, Q28, Q32, Q34).
- **Artifact Cycle Time is independent of the stall rule.** Median(`created_at` → the artifact's own done event) over completed items in the trailing 90 days, per artifact type, computed separately from the Incomplete Pipeline's stall-aware logic (Q7, Q35; BR-007).
- **My Work branching.** Apex/Amego: Ready = approved Feature with no session; In Progress = active `devSessions` row; done = `completed` session. Azure DevOps projects: Ready-equivalent = New/Approved/Committed; In Progress = In Progress/Active; done = Done/Closed. Gated by `dev-workbench:view` **and** Developer group membership (Q8; BR-008, BR-013).
- **Open Bugs on PBIs.** Counts only Bugs linked via `System.LinkTypes.Hierarchy-Forward` (child-of-PBI), excluding states Done, Closed, Resolved, Removed; Bugs linked via Related/Duplicate are never counted (Q9, Q33; BR-009). Gated by `calendar:view` (BR-014).
- **Developer-to-production cycle time.** Median(first developer start → linked Release's production `deployedAt`) over the trailing 90 days, project-wide; items not linked to a Release with a recorded production deployment are excluded outright (not counted as zero) (Q10, Q18; BR-010, BR-014). "Linked to a Release" means the ADO work item carries the `Release:<name>` tag already used by `renameRelease`/`findWorkItemsWithReleaseTag` in `releaseManagementService.ts`/`azureDevOps.ts`. Gated by `planning:releases` (BR-014).
- **`interviews:view` and `dev-workbench:view` already exist as live, enforced permissions.** Confirmed in code (`router.use(requirePermission('dev-workbench:view'))` in `devWorkbench.ts`; equivalent guard pattern in `interviews.ts`) even though `rbac-governance.mdc`'s documented Permission Catalog table omits both keys. No RBAC catalog migration is in scope for this Feature — this is a documentation gap in an existing rule file, not a missing permission.
- **No existing endpoint computes the developer-to-production join.** Confirmed by reading `releaseManagementService.ts` and `deploymentOutcomeService.ts` in full — TBI-003 is genuinely new work, not a wrapper around something that already exists.
- **Test Case group scoping.** PRDs with `testCasesEnabled = false` are omitted from the Test Case group entirely; `'ready'` is the literal status value already used by `prdService.ts` (`eq(testCases.status, 'ready')`) to mean "suite ready."
- **No dedicated Test Case detail route.** Test Case rows open the parent PRD; the Test Case group's "View all" opens `/backlog?tab=prds` (Q26–Q27; PRD's own recorded assumption).
- **No Calendar deep link pre-selects a PBI today.** The Open Bugs tile's row click and "View all" both land on `/calendar` generally, matching the PRD's own recorded assumption.
- **No tile is hidden by project name.** Amego (ADO-integrated today) and Apex (native PRDs, ADO integration pending) run the same tile code path. Until Apex's ADO integration ships, the Open Bugs and Developer-to-Production tiles simply render their existing "no qualifying data in the last 90 days" empty state for Apex-native projects — they are never conditionally hidden based on which project is selected (Q36–Q37).
- **Sort order.** Every list tile sorts oldest-`updated_at`-first ("stalest on top"), matching BR-006 and Q34.
