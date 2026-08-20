# PRD Spec Review — Scoring Rubric (Apex)

All sections in both files use a 0–3 scale. The confidence score formula is:

```
per-file score = (Σ section_score × section_weight) / (3 × Σ section_weight) × 100
```

File weights: **PRD markdown 50%, backlog JSON 50%**.

---

## Canonical Apex Enums (use ONLY these values — do not substitute or invent alternatives)

### Persona names (Apex groups enum)
`Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`

**Alias:** Interview or PRD wording **"Super Admin"** maps to **`Platform Admin`**. Do not score Super Admin vs Platform Admin as a persona mismatch or invent a separate Super Admin enum value.

### Persona types
`Internal`, `Admin`, `Technical`

### Target surface labels (PRD `## Target Surface`)
`Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`

### MoSCoW priority values
`Must Have`, `Should Have`, `Could Have`, `Won't Have`

### Apex glossary terms (from context.md and AGENTS.md)
`Interview`, `PRD`, `Design Doc`, `Design Prototype`, `PBI`, `TBI`, `Feature Flag`, `Skill`, `Backlog`, `Epic`, `Feature`, `RBAC`, `SSE`, `Facilitator`

**CRITICAL:** These are the Apex platform's own terms. Apex is a product-building platform — it is NOT a timeclock, staffing, or healthcare application. Do not apply domain terms from other products (e.g. Match, HCP, Worksite, Timesheet, Credential). Score persona compliance, target surface, and terminology against the enums listed above only.

---

## Score Scale

| Score | Label | Meaning |
|-------|-------|---------|
| 0 | Missing | Section absent, or body is still a template placeholder (`{...}`) or `[TBD]` |
| 1 | Shallow | Section header present with minimal or generic content; no domain or codebase grounding |
| 2 | Substantive | Addresses intent with specific, named detail |
| 3 | Complete | Actionable, traceable, and ready to hand off to `/prd-design-spec` or implementation |

---

## PRD Markdown (`{slug}.prd.md`)

### Frontmatter — weight 5

| Score | Evidence |
|-------|----------|
| 0 | Frontmatter block missing entirely |
| 1 | Some fields present; `triage-status` missing or value is not `needs-triage` |
| 2 | `triage-status: needs-triage` and `glossary-terms-used` both present; one field is empty or still a template placeholder |
| 3 | All fields populated; `triage-status: needs-triage`; `glossary-terms-used` lists at least 3 Apex domain terms |

### Problem Statement — weight 8

| Score | Evidence |
|-------|----------|
| 0 | Section missing or still has `<template token>` placeholder |
| 1 | One-line description; no affected persona or current pain articulated |
| 2 | States the problem and who is affected; no measurable impact or evidence |
| 3 | States the problem, affected persona, current-state pain, and measurable evidence or impact; 2–4 sentences; written from the user's perspective |

### Proposed Solution — weight 8

| Score | Evidence |
|-------|----------|
| 0 | Section missing or still has `<template token>` placeholder |
| 1 | Restates the problem; no end-state described |
| 2 | End state described at a feature level; no non-goals or alternatives considered |
| 3 | End state described in user-visible terms; lists at least one explicit non-goal; states the key trade-off or alternative considered |

### User story contract (backlog-owned) — weight 15

| Score | Evidence |
|-------|----------|
| 0 | PRD contains an authored `## User Stories` section (contract violation); OR backlog has no PBI `userStory` objects |
| 1 | PRD correctly omits `## User Stories`, but at least one PBI is missing `userStory` or uses a persona not in the Apex groups enum (valid: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`) |
| 2 | Every PBI has a complete `userStory` with valid Apex persona; PRD omits authored stories; 1–2 stories not traceable to PRD `## Solution`; or `iWant` names a system artifact (table, endpoint, helper, schema) instead of a persona action |
| 3 | PRD has no authored stories; every PBI `userStory` uses Apex enum persona verbatim and is in parent Feature `affectedPersonas`; every `iWant` is a verb phrase the persona performs; every story traces to PRD content |

### Target Surface — weight 8

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Surface label present but not one of the allowed values (`Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`) |
| 2 | Valid label present; backlog PBIs may imply a different surface |
| 3 | Valid surface label; backlog PBIs/TBIs consistent with that surface |

### Access Control and Permissions — weight 10

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Groups listed but no action column or data scope column |
| 2 | Action/group/scope table present with at least one row |
| 3 | Table complete; group/role names match Apex groups enum or RBAC permission keys; data scope uses allowed values (`Project-scoped`, `User-scoped`, `Global`, `No restriction`) |

### Security and Data Sensitivity — weight 8

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Section present but fields still have placeholders |
| 2 | Sensitive fields identified or stated as "None"; handling requirements not specified |
| 3 | Fields identified with classification or stated as "None"; handling requirements populated; data scope enforcement described |

### Non-Functional Requirements — weight 7

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Section present but all bounds blank or `[TBD]` |
| 2 | Most bounds populated; 1 left as "Not specified" |
| 3 | All bounds (response time, concurrency, data volume) populated with concrete values |

### Feature Flag — weight 7

| Score | Evidence |
|-------|----------|
| 0 | Section missing or **Flag required** field blank |
| 1 | **Flag required** present but rollout/disabled fields missing |
| 2 | All five PRD fields populated; backlog alignment partial |
| 3 | All five fields correct: No → no backlog `featureFlag`; Yes → matching names |

### Implementation Decisions — weight 8

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Section present but contains file paths or code snippets |
| 2 | Module-level decisions described; rationale thin |
| 3 | Each decision names the module, approach, and rationale; no file paths or code |

### Assumptions Made — weight 8

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Section present but empty |
| 2 | Assumptions listed; no risk noted |
| 3 | Every assumption states what was assumed, derivation source, and risk if wrong |

### Apex Terminology Compliance — weight 7

Check against the Apex glossary terms listed at the top of this rubric. Apex is a product-building platform — score only against Apex-specific terms, not domain terms of other products.

| Score | Evidence |
|-------|----------|
| 0 | Multiple non-canonical Apex terms used (3+) |
| 1 | 1–2 non-canonical Apex term uses |
| 2 | Canonical Apex terms used in most instances; 1 minor slip |
| 3 | All Apex terms used correctly: Interview, PRD, Design Doc, Design Prototype, PBI, TBI, Feature Flag, Skill, Backlog, Epic, Feature |

### No Residual Template Tokens — weight 1

| Score | Evidence |
|-------|----------|
| 0 | 3+ `{token}` or `[TBD]` patterns found |
| 1 | 1–2 `{token}` or `[TBD]` patterns found |
| 3 | Zero `{token}`, `[TBD]`, or `TODO` patterns |

---

## Backlog JSON (`{slug}.backlog.json`)

### Personas — weight 8

Valid persona names: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`. Valid types: `Internal`, `Admin`, `Technical`.

| Score | Evidence |
|-------|----------|
| 0 | `personas` array missing or empty |
| 1 | Names present but at least one does not match the Apex groups enum listed above |
| 2 | All names from enum; descriptions are generic |
| 3 | All names match enum exactly; each description states the persona's specific role within this PRD's scope |

### Business Rules — weight 10

| Score | Evidence |
|-------|----------|
| 0 | `businessRules` array missing or empty |
| 1 | Rules present but IDs don't match `BR-NNN` pattern |
| 2 | Rules have `BR-NNN` ids, rule text, and `appliesTo`; some rule text is generic |
| 3 | Every rule has a precise constraint statement and valid `appliesTo` |

### Epic structure — weight 10

| Score | Evidence |
|-------|----------|
| 0 | `epics` array missing or empty |
| 1 | Required fields present; `description` is one sentence |
| 2 | Business narrative 2–4 sentences; success metrics measurable |
| 3 | Complete with quantified success metrics, explicit out-of-scope, assumptions, and dependencies |

### Feature structure — weight 10

Optional `userTypes` / `personaBehaviors` on Features are schema-valid (design-prototype enrichment). Do **not** score 0 solely because they are present. TBIs must not have these fields (scored under TBI structure).

| Score | Evidence |
|-------|----------|
| 0 | Feature missing any required field; or contains properties not in `backlog-schema.json` (e.g. `route`, `compliance`) |
| 1 | Required fields present; feature-flag alignment broken; or `affectedPersonas` / `userTypes` contains names not in the Apex groups enum (after mapping Super Admin → Platform Admin) |
| 2 | Fields present; flag matches PRD; description generic |
| 3 | All fields complete; `affectedPersonas` uses Apex enum names only; flag alignment correct; description names capability and beneficiary; no extra properties beyond schema |

### PBI user stories and structure — weight 12

Optional `userTypes` / `personaBehaviors` on PBIs are schema-valid (design-prototype enrichment). Do **not** score 0 solely because they are present.

| Score | Evidence |
|-------|----------|
| 0 | PBI missing any required field; or contains properties not in `backlog-schema.json` (e.g. `compliance`) |
| 1 | `userStory.persona` not from Apex groups enum (valid: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`; Super Admin ≡ Platform Admin) |
| 2 | Complete with valid Apex persona; `nonFunctionalRequirements` sub-fields (`performance`, `accessibility`, `security`) have some blanks; or `iWant` is a noun/artifact ("a table", "endpoints", "helpers") rather than a verb phrase |
| 3 | All fields populated; persona from Apex enum; `iWant` is a verb phrase the persona performs (completes "I want to …"); NFR sub-fields (`performance`, `accessibility`, `security`) populated with concrete values; no extra properties beyond schema |

### Acceptance Criteria coverage — weight 15

| Score | Evidence |
|-------|----------|
| 0 | `acceptanceCriteria` array missing or < 4 items |
| 1 | 4+ rows but not all four scenarios represented |
| 2 | All 4 scenarios for most PBIs; Then clauses vague |
| 3 | Every PBI has all 4 rows with concrete, testable Then clauses |

### TBI structure — weight 10

| Score | Evidence |
|-------|----------|
| 0 | TBI missing required fields; has a `userStory` field; or has `userTypes` / `personaBehaviors` (those belong on Features/PBIs only) |
| 1 | `description` is one sentence; `definitionOfDone` < 3 items |
| 2 | Description 2–4 sentences; DoD 3+ items but some not verifiable |
| 3 | All fields populated; description names module and approach; DoD items are independently verifiable; no persona enrichment fields |

### dependsOn graph validity — weight 8

**Dependency locality (hard gate):** Item-level `dependsOn` (on PBIs/TBIs) may reference only items within the **same Feature**. Cross-Feature relationships must be expressed via `feature.dependsOn` (`FEAT-NNN`); shared/foundational work must be extracted into its own Feature in an earlier `implementationPhase`. ANY item-level `dependsOn` referencing an item in a different Feature is a decomposition error that forces this section to **0**.

| Score | Evidence |
|-------|----------|
| 0 | Cycle detected or dangling reference; OR any item-level `dependsOn` references an item in a different Feature (decomposition error — cross-feature needs must use `feature.dependsOn` or a shared earlier-phase Feature) |
| 1 | Valid DAG but parallel groups share resources |
| 2 | Valid DAG; parallel labels used |
| 3 | Valid DAG; no cycles; no dangling refs; parallel groups confirmed safe |

### assumptionsMade consistency — weight 7

| Score | Evidence |
|-------|----------|
| 0 | `assumptionsMade` array missing or empty |
| 1 | Array present but diverges from PRD |
| 2 | Matches PRD in substance; minor wording differences |
| 3 | Identical in meaning to PRD `## Assumptions Made` |

### Schema compliance — weight 5

The backlog schema uses `additionalProperties: false` at every level. Extra properties (e.g. `route`, `compliance`) are schema violations. Optional `userTypes` / `personaBehaviors` on **Features and PBIs** are defined in the schema — do **not** treat them as violations. Those fields on **TBIs** are violations.

| Score | Evidence |
|-------|----------|
| 0 | JSON does not validate against `backlog-schema.json` — extra properties, invalid persona enum values, or invalid persona type values |
| 1 | Validates structurally but `priority` values wrong or persona `type` not in (`Internal`, `Admin`, `Technical`) |
| 2 | Validates; enum values correct; 1–2 ID pattern mismatches |
| 3 | Fully validates; all IDs match patterns; all priorities from enum; zero extra properties; persona types valid |

### Implementation Phases — weight 5

| Score | Evidence |
|-------|----------|
| 0 | `implementationPhases` array missing or empty |
| 1 | Phases present but not all epics assigned, or epic titles don't match `epics` array exactly |
| 2 | All epics assigned to a phase; rationale present but generic |
| 3 | Every epic assigned to exactly one phase; rationale explains dependency reasoning; phase ordering is consistent with epic `dependencies` fields |
