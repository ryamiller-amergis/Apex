# Design — Quality Manifest and NFR Manifest

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Testing, Quality Manifest and Supply Chain | **Affected personas:** Platform Admin, Developer, QA
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (6 unresolved)

---

## Feature Summary

**Description:** Platform Admin needs to build a pipeline without re-reading repository logic. Developers need a visible record when a check cannot run yet. QA needs to show that performance was checked against stated targets, not only that tests passed. This Feature adds two machine-readable files to the sample template (`templates/full-stack-express/`): a quality manifest that lists every gate with the script that runs it, and an NFR manifest where each project states its response-time, concurrency, and data-volume targets. A validator script checks both files, and a sample load test reads its targets from the NFR manifest. The manifests say what exists and what the targets are. They never say when anything runs.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-027 | TBI | Create the quality manifest schema and file | Must Have |
| TBI-028 | TBI | Create the NFR manifest schema and load-test tooling | Should Have |
| TBI-029 | TBI | Add the manifest validator | Must Have |
| PBI-024 | PBI | Invoke every quality gate from the manifest by script name | Must Have |
| PBI-025 | PBI | Record a justified deferral for a gate | Should Have |
| PBI-026 | PBI | Trace non-functional requirements to verification evidence | Should Have |

---

## Scope and Out-of-Scope

**In scope:**
- A quality manifest schema and a committed manifest. The manifest lists 12 gates (build, type-check, lint, formatting, OpenAPI drift, migration validation, unit, component, API, integration, accessibility, container build). Each gate names one script. The manifest also records the coverage floors (80% lines, functions, and statements; 75% branches) and a list of justified deferrals. Each deferral needs a reason and an owner.
- An NFR manifest schema and a committed manifest with illustrative values for response time, concurrency, and data volume. Each value is labeled illustrative.
- A sample load-test definition and a runner. The definition reads its targets from the NFR manifest. The runner reports pass or fail per target.
- A validator script that checks both manifests against their schemas, confirms every named script exists, confirms the coverage floors match the shared configuration, and prints a summary of gates, deferrals, and NFR targets.
- Plain-text documentation in `quality/README.md` that states each consuming team decides when gates and load tests run.

**Out of scope:**
- Execution tiers, schedules, and push or pull-request policies (Feature).
- Fixed NFR targets for generated projects (Feature). Choosing targets for a project (PBI-026).
- Writing the pipeline, and choosing which gates run on which events (PBI-024). Platform Engineering owns both.
- An approval workflow for deferrals, and expiry reminders (PBI-025).
- Running load tests automatically (PBI-026). A person or a team's own pipeline starts each run.
- Contract-test and supply-chain gates in the manifest. The PRD list has 12 gates, so these five scripts are not manifest gates in this release (⚠ see assumptions).
- Any change to Apex runtime behavior, its database, services, or RBAC. The template is not wired into Apex.
- Pipeline definitions, AWS and ECS configuration, and repository governance files (Platform Engineering).

---

## Target Surface

**Primary surface:** Backend only. The work is command-line scripts and committed JSON files inside the template workspace. It adds no React screen and no Express route. The PRD marks the template as a whole as full-stack, but this Feature touches neither the web client nor the API process.

**Experience notes:** The user experience is terminal output and plain-text files. The validator prints one line per finding, then a summary. Anyone can read the manifests in any editor, and an agent can read them without starting the application. There is no Apex navigation entry.

---

## Access Control

The template defines no roles, permissions, or authorization policy (BR-003). Access follows repository access in the consuming project.

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Read the manifests and call a gate's named script | Platform Admin (Platform Engineering's pipeline), Developer, QA, or an agent acting for one. Anyone with the checkout. | No restriction (repository-local) |
| Record a deferral in the quality manifest | Developer, through normal code review in the consuming repository | No restriction (repository-local) |
| Fill in NFR targets for a project | The consuming team | No restriction (repository-local) |
| Run the sample load test | QA or Developer, against an environment the team names in `LOAD_TEST_BASE_URL` | No restriction. The runner never picks an environment. |
| Review the template in Apex and move it into the bootstrap source | Platform Engineering (mapped to `Platform Admin`) | Global |
| Role-based authorization for any of the above | Not defined. An extension point for Platform Engineering. | Not applicable |

**Feature flag:** `None` — rollout: Not applicable. The sample is a reviewable folder that does not change Apex runtime behavior.
**Behavior when flag is off:** Not applicable. The template's own provider-neutral flag interface (FEAT-008) is separate from this Feature.

---

## Acceptance Criteria

### PBI-024 — Invoke every quality gate from the manifest by script name

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I read the quality manifest | I run the script named for a gate | The gate runs and exits zero on success and non-zero on failure |
| (b) Error/failure | A gate script does not exist | I run the manifest validator | The validator fails and names the gate and the missing script |
| (c) Edge case/boundary | A gate is deferred with a reason and owner | I run the validator | The deferral is accepted and listed in the output |
| (d) Negative scenario | I look for execution tiers or schedules in the manifest | I read it | None are defined and the documentation states each team decides |

### PBI-025 — Record a justified deferral for a gate

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A gate cannot run yet | I add a deferral with a reason and an owner and run the validator | The validator accepts it and reports the deferred gate |
| (b) Error/failure | I add a deferral with no reason | I run the validator | The validator fails and names the incomplete deferral |
| (c) Edge case/boundary | A deferral names a gate that does not exist | I run the validator | The validator fails with the unknown gate name |
| (d) Negative scenario | A gate is deferred | I read the manifest summary | The deferral is listed and the gate is not reported as passed |

### PBI-026 — Trace non-functional requirements to verification evidence

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A project fills in its targets in the NFR manifest | I run the sample load test | The test applies those targets and reports pass or fail against each |
| (b) Error/failure | The NFR manifest is missing required target fields | I run the manifest validator | The validator fails and names the missing fields |
| (c) Edge case/boundary | The manifest contains only the illustrative example values | I read the manifest and run the validator | The values are labeled illustrative and the validator warns that the project has not set real targets |
| (d) Negative scenario | I look for a statement of when load tests run | I read the template documentation | None is given and the documentation states each team defines it |

**Technical items covered by the criteria above:**

| TBI | Verified through |
|-----|------------------|
| TBI-027 | PBI-024 (a), (b), (d); PBI-025 (a) to (d) |
| TBI-028 | PBI-026 (a) to (d) |
| TBI-029 | PBI-024 (b), (c); PBI-025 (b), (c); PBI-026 (b), (c) |

---

## UI/UX

Not applicable. This Feature adds no screen, route, or React component, so there are no component states, `data-testid` attributes, or accessibility rules for a UI.

Output rules that stand in for UI rules:
- **Plain text only.** The manifests, README, validator output, and load-test results are plain text. Screen readers and any editor can read them.
- **One finding per line,** prefixed `ERROR`, `WARN`, or `INFO`. Each error line names the file, the JSON path, and the rule broken.
- **No secret values in output.** Error lines name a field or variable, never its value. Deferral text must not contain secrets.
- **Illustrative values carry a label** in the schema, the manifest, the README, and the validator warning.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
