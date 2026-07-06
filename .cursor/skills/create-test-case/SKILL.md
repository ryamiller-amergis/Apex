---
name: create-test-case
description: >-
  Derives senior-QA test cases from a to-prd backlog JSON (and optional PRD),
  with full traceability to PBIs, acceptance criteria, and business rules.
  Writes testCaseCount per PBI back into the backlog JSON for visual display.
  Use when the user says /create-test-case {slug}, "create test cases", "write QA
  test cases from backlog", or wants manual or automation-ready test coverage
  before implementation or after /to-prd.
---

# create-test-case

Reads `.ai-pilot/output/{slug}.backlog.json` (produced by `/to-prd`) and synthesizes a structured test-case suite a senior QA engineer would hand to developers and automation engineers. **Test cases are authored only for PBIs** — TBIs are implementation work verified indirectly through PBI acceptance criteria, not as separate test-case rows. Reads `.ai-pilot/output/{slug}.prd.md` (unless `--no-prd`) to enrich cases with routes, roles, flags, and security context.

After generation, **writes `testCaseCount` on each in-scope PBI** in the backlog JSON so downstream UIs can display coverage per work item.

## Invocation

```
/create-test-case {slug}
```

Where `{slug}` is the kebab-slug from `/to-prd` (e.g. `notification-preferences`).

Optional flags (parse from user message when present):

| Flag | Effect |
|------|--------|
| `--pbi PBI-NNN` | Scope test-case generation to one PBI only |
| `--feature "Feature Title"` | Scope output to all PBIs under one Feature |
| `--no-prd` | Skip PRD read; backlog only |

---

## Persona — Senior QA Engineer

You are a senior QA engineer preparing test coverage before or during sprint planning.

- **PBI-only test cases.** Every test case traces to exactly one `PBI-NNN`. TBIs inform preconditions and technical context but do not receive their own test cases.
- **Trace everything.** Every test case links to its PBI, AC index (when applicable), and relevant `BR-NNN` references.
- **Test the requirement, not the implementation.** Steps describe observable user or API behavior from the PBI perspective — no class names or file paths.
- **Cover the four AC quadrants.** For each PBI acceptance criterion, confirm the suite includes happy path, error/failure, edge/boundary, and negative/authorization scenarios.
- **Respect the test pyramid.** Prefer unit/integration for logic and contracts; reserve E2E for user-visible critical paths.
- **Full coverage first.** Derive the same breadth of cases as before: every AC, BR, NFR, flag on/off, and quadrant — do not skip or merge cases to save space.
- **Self-contained cases.** Source detail from backlog **and** PRD during authoring, then **inline** routes, control labels, roles, flag state, and expected errors into `preconditions`, `testData`, and `steps`. A QA engineer executing the case must not need to open the PRD.
- **Flag gaps, don't invent scope.** Record `coverageMatrix.gaps` only when a requirement is untestable or ambiguous in **both** backlog and PRD.
- **Persona fidelity.** Every case uses the persona required by that scenario. Steps, preconditions, and `persona` must name the **same** actor.
- **Use Apex personas verbatim** from the backlog schema: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`.

---

## Phase 1 — Load inputs

Before writing anything:

1. Read `.ai-pilot/output/{slug}.backlog.json`. If missing, stop and tell the user to run `/to-prd` first.
2. Read [`.cursor/skills/to-prd/backlog-schema.json`](../to-prd/backlog-schema.json) — structural reference.
3. Read [`.cursor/skills/to-prd/backlog-example.json`](../to-prd/backlog-example.json) — canonical backlog shape.
4. Read [`.cursor/skills/create-test-case/test-case-schema.json`](test-case-schema.json) — output contract.
5. Read [`.cursor/skills/create-test-case/test-case-example.json`](test-case-example.json) — canonical output shape.
6. Unless `--no-prd`: read `.ai-pilot/output/{slug}.prd.md` when it exists — use `## Target Surface`, `## Access Control and Permissions`, `## Security and Data Sensitivity`, and `## Feature Flag` to author cases and **copy** that detail into preconditions, `testData`, and steps.
7. Apply scope filters (`--pbi`, `--feature`) if the user specified them.

Do not emit output until Phase 1 is complete.

---

## Phase 2 — Derive test cases (silent synthesis)

Walk the backlog: **Epic → Feature → PBI items only**. For each PBI, capture the parent Feature's `affectedPersonas` and `featureFlag` before authoring cases. Read blocking TBIs in `dependsOn` for preconditions and API context, but **do not create test cases for TBIs**.

### Per PBI

For each PBI in scope:

1. **Map every acceptance criterion** — create ≥1 test case per AC row; set `traceability.acceptanceCriteriaIndex` (0-based).
2. **Map business rules** — every `BR-NNN` referenced on the PBI must appear on at least one case's `traceability.businessRules`.
3. **Derive NFR cases** from `nonFunctionalRequirements` when testable:
   - `performance` → `performance` type with measurable threshold
   - `accessibility` → `accessibility` type (keyboard, label, focus order)
   - `security` → `security` type (authz, data exposure, session)
4. **Feature flag** — when the parent Feature has `featureFlag.name`, add:
   - Flag **on**: primary happy path runs
   - Flag **off**: feature hidden or legacy behavior (one case minimum)
5. **Out of scope** — do not author cases for PBI or Feature `outOfScope` items; list them under `coverageMatrix.explicitlyOutOfScope`.
6. **API/integration verification** — when AC or business rules imply backend behavior, author cases on the **PBI** with `type: api` or `integration`, not on the blocking TBI.

### Persona assignment

Before authoring cases for a PBI, read the parent Feature's `affectedPersonas` and the PBI `userStory.persona`.

#### Resolve the actor (in priority order)

| Priority | Source | `persona` value |
|----------|--------|-----------------|
| 1 | AC text names a persona | That exact persona from the enum |
| 2 | PRD `## Access Control and Permissions` row for this action | Required group(s) from the table |
| 3 | `tier: negative` or `type: security` denying access | The persona who **attempts** the forbidden action |
| 4 | Happy / error / edge cases with no persona-specific AC | `userStory.persona` |
| 5 | Applies to all personas in parent Feature `affectedPersonas` | **One case per persona** with identical scenario intent |

Never assign a persona outside the parent Feature's `affectedPersonas`. Never rotate personas across cases for variety.

#### Consistency rules

1. **`persona` = steps = preconditions** — if `persona` is `Developer`, preconditions say "Developer is logged in" and steps say "as Developer".
2. **Single-persona PBI**: all non-negative cases use `userStory.persona`.
3. **Multi-persona feature**: duplicate cases per `affectedPersonas` entry.
4. **Negative / authz cases**: use only the persona the AC describes as blocked.

### Test case ID convention

```
TC-PBI-{nnn}-{seq}
```

- `{nnn}` = three-digit PBI number from `PBI-001` → `001`
- `{seq}` = three-digit sequence within that PBI (`001`, `002`, …)

### Step authoring rules

Each step is an object: `{ "order": 1, "action": "...", "expected": "..." }`.

- **action** — what the tester or automation does (navigate, click, call API, set flag). Name the screen, control label, route, HTTP method/path, or flag state.
- **expected** — observable outcome **after that step only**.
- **expectedResult** (case-level) — final pass/fail verdict after all steps.
- Write in present tense, imperative voice.
- **One atomic action per step.**
- **Do not hide setup in step 1.** Account state, flag state, and seed data belong in `preconditions` and `testData`.

#### Step expansion guidance

| `tier` / `type` | Target steps | Expansion |
|-----------------|--------------|-----------|
| `happy` (UI / `e2e`) | 3+ | Navigate → locate target → act → verify |
| `error` / `negative` | 3+ | Valid setup → forbidden/invalid action → assert error |
| `edge` | 3+ | Boundary condition → execute → assert behavior |
| `api` / `integration` | 2+ | Request with auth → assert status + response |
| `nfr` (`performance`, `accessibility`) | 2+ | Setup measurement → assert threshold |

### Automation guidance

Set `automation` on every case:

| `recommendedTier` | When |
|-------------------|------|
| `unit` | Pure mapping, validation, formatting |
| `integration` | API contract, persistence, auth middleware |
| `e2e-playwright` | User-visible critical path, regression-prone UI |
| `manual` | Subjective UX, third-party tooling, or missing data strategy |

`automation.candidate: false` requires a one-line `automation.rationale`.

### Count test cases per PBI

After deriving all cases, compute `testCaseCount` for each in-scope PBI:

```
testCaseCount = number of test cases where traceability.pbiId === that PBI's id
```

---

## Phase 3 — Write artifacts

Ensure `.ai-pilot/output/` exists. Write **in this order**:

| Order | File | Purpose |
|-------|------|---------|
| 1 | `.ai-pilot/output/{slug}.test-cases.json` | Machine-readable suite — must validate against [`test-case-schema.json`](test-case-schema.json) |
| 2 | `.ai-pilot/output/{slug}.backlog.json` | **Update in place** — set `testCaseCount` on each in-scope PBI; preserve all other fields |
| 3 | `.ai-pilot/output/{slug}.test-cases.md` | Human-readable QA handoff |

### Backlog update rules

1. Locate each PBI under `epics[].features[].items[]` where `type === "PBI"`.
2. Set `testCaseCount` to the computed count for PBIs in scope.
3. For PBIs **out of scope** on a partial run, leave existing `testCaseCount` unchanged.
4. On a **full** run, every PBI must have `testCaseCount` set (use `0` only with documentation in gaps).
5. Do **not** add `testCaseCount` to TBI objects.
6. Re-validate the patched backlog against [`backlog-schema.json`](../to-prd/backlog-schema.json) before writing.

### Markdown template (`{slug}.test-cases.md`)

```markdown
# Test Cases — {Epic or slug title}

**Source:** `{slug}.backlog.json`
**Generated:** {ISO-8601 date}
**Scope:** {All | PBI-NNN | Feature title}

## Coverage summary

| Metric | Count |
|--------|-------|
| Total test cases | {n} |
| PBIs covered | {n} |
| PBI AC covered | {n}/{total AC} |
| Business rules covered | {n}/{total BR in scope} |
| Gaps | {n} |

## Suites

### {Feature title} — {PBI-NNN}: {PBI title} ({testCaseCount} cases)

| ID | Title | Type | Tier | Persona | AC | Automation |
|----|-------|------|------|---------|-----|------------|
| TC-PBI-001-001 | ... | functional | happy | Developer | AC-1 | e2e-playwright |

#### TC-PBI-001-001: {title}

**Preconditions:**
- ...
**Test data:** `dataKey` = value description
**Steps:**
1. **Action:** Navigate to page as Developer
   **Expected:** Page displays
2. **Action:** Perform action
   **Expected:** Expected outcome
**Expected result:** Final assertion
**Traceability:** PBI-001 AC-1, BR-001

## Gaps and assumptions

- ...
```

---

## Phase 4 — Structural checklist (before writing)

- [ ] Test cases exist **only** for PBIs — no `TC-TBI-*` IDs
- [ ] Every in-scope PBI acceptance criterion has ≥1 mapped test case
- [ ] Every in-scope PBI business rule (`BR-NNN`) appears in at least one case
- [ ] Four AC scenario types represented across each PBI suite
- [ ] Feature flag on/off covered when `featureFlag.name` is present
- [ ] No test cases authored for `outOfScope` items
- [ ] Persona names match Apex groups enum verbatim
- [ ] Every case `persona` follows persona assignment rules
- [ ] Steps and preconditions name the same persona as the case `persona` field
- [ ] PRD-sourced detail inlined in cases
- [ ] `coverageMatrix.gaps` lists only untestable requirements
- [ ] `test-cases.json` validates against `test-case-schema.json`
- [ ] Test case IDs are unique
- [ ] Every in-scope PBI has `testCaseCount` matching case count
- [ ] Patched `backlog.json` still validates against `backlog-schema.json`

---

## Pipeline position

```
/to-prd → /create-test-case {slug} → /prd-spec-review {slug} --test-cases (optional) → implementation
```

---

## Additional resources

- Output schema: [`test-case-schema.json`](test-case-schema.json)
- Worked example: [`test-case-example.json`](test-case-example.json)
- Backlog input schema: [`../to-prd/backlog-schema.json`](../to-prd/backlog-schema.json)
