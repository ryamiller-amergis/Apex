# Assumptions & Unresolved Items — Quality Manifest and NFR Manifest

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.
> Generated without the interactive refinement session. Every ⚠ item carries a recommended default, and the other two files already follow that default. Changing an answer means editing those files too.

---

## Unresolved Items

Items that could not be inferred from the PRD, backlog, or codebase. Each must be decided before the relevant implementation step starts.

- ⚠ **Load-test tool**: The PRD says only "selected from the organization-approved set" (TBI-028). No tool is named. The choice sets the file format of the sample load-test definition and what the runner calls. It blocks step S2 (the definition file) and step S5 (the runner). **Recommended default:** k6, run from a pinned `grafana/k6` container image so the lockfile and Docker Compose remain the only install paths. Apex already ships k6 load-test definitions and a `k6-load-test-generation` skill, and k6 thresholds map directly to a per-target pass or fail. Platform Engineering must confirm k6 is on the approved list. If it is not, the nearest npm-installable option (for example autocannon) needs a different runner adapter, and `quality/load-test/` changes shape.

- ⚠ **How the sample load test checks the data-volume target**: PBI-026 (a) requires a pass or fail "against each" target, and data volume is one of three. Nothing in the template reports a row count. There is no list endpoint (PRD, Identity and access), and bulk data generation for load tests is out of scope (FEAT-003 seed PBI). This blocks step S5. **Recommended default:** the runner runs a read-only `SELECT count(*)` against the table named in the manifest, using `LOAD_TEST_DATABASE_URL`. It reports `PASS` or `FAIL` against `rows`. If the variable is unset, it reports `NOT MEASURED` and exits non-zero, so an unmeasured target is never read as a pass. Product and Platform Engineering must confirm they accept a direct database read in the runner. The alternative is to report data volume as "declared, not measured" and amend PBI-026 (a).

- ⚠ **Gate set omits contract tests and supply-chain scans**: The PRD and TBI-027 list 12 gates. Contract conformance tests (TBI-026), secret scan, vulnerability scan, license check, and SBOM generation (TBI-030, TBI-031) each have a script. The epic success metric says each "runs from a script". None appears in the manifest, so the QA and integration skills (which read the manifest) cannot see them. **Recommended default:** ship exactly the 12 PRD gates. The schema accepts any kebab-case gate id and the validator requires the 12 core ids. Adding `contract-test`, `secret-scan`, `vulnerability-scan`, `license-check`, and `sbom` later is a data edit, not a schema change. Product must decide whether to add them now. If yes, TBI-027 gains five gate entries and VT-01 changes from 12 to 17 gates.

- ⚠ **Owner of the script behind each gate**: TBI-027 requires that "each gate names an existing script", and TBI-029 enforces it. The backlog names a script only for part of the set. The OpenAPI drift check (TBI-010 in FEAT-004), migration validation (FEAT-003), and the test commands (TBI-023 to TBI-026) have an owning item. No backlog item creates scripts for `build`, `type-check`, `lint`, `formatting`, or `container-build`. TBI-005 lists install, build, check, test, run, migrate, and seed only. TBI-032 defines the container image but no build script. This blocks step S1, because the committed manifest cannot validate until every script exists. **Recommended default:** the script names in the tech spec (section "Gate-to-script map") are proposals, and the owners of FEAT-001, FEAT-003, FEAT-004, FEAT-011, and TBI-032 add the missing root scripts under those names. Decide before S1 whether this feature adds the missing scripts itself or waits for the other owners.

- ⚠ **Apex root formatting check on the new files**: Apex's `npm run lint` runs `prettier --check .` over the whole repository. The new JSON, Markdown, and `.mjs` files under `templates/full-stack-express/` are inside that scan. The PRD already lists this as open (FEAT-001, TBI-001). It affects this feature because hand-written JSON Schema and manifest files are long and Prettier rewraps them. This blocks step S8. **Recommended default:** format every file with Apex's `.prettierrc` (single quotes, 80 columns, `es5` trailing commas) so no ignore entry is needed. Maintainers must confirm they prefer that over an approved ignore entry.

- ⚠ **Accepted ADR text is unavailable**: The PRD cites the accepted ADR "Build from prompt (single-prompt-build-orchestration)" for the quality manifest, but its text was not in the repository checkout. The ADR may require manifest fields that agents expect (for example per-gate evidence paths). That would change the schema in S1. **Recommended default:** build to the backlog as written. A reviewer who has read the ADR must compare it with the schema in the tech spec (section "File and CLI contracts") before S1 starts.

---

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

- **Manifest format is JSON validated with Ajv**: Both manifests are JSON files with JSON Schema (draft 2020-12) schemas, validated by `ajv/dist/2020`. TBI-027 and TBI-028 list JSON Schema as the dependency, and the manifest must be readable "without running the application". JSON needs no parser in any pipeline language. Risk: JSON has no comments, so rationale lives in `description` fields and the README. YAML would read better and add a parser dependency.

- **No new workspace member**: The manifests and validator live in `quality/` and `scripts/quality/` at the template root. TBI-001 fixes the workspace at five members, and a sixth package would change that. Risk: root-level scripts sit outside the shared Vitest and lint setup unless the root scripts include them (see the `test:quality` assumption).

- **Validator is plain Node ESM (`.mjs`)**: It follows Apex's `scripts/ci/check-codemap-paths.mjs` and `scripts/validate-foundation-skills.mjs`. It needs no build step, so it runs on a clean checkout before `build`. Risk: the type-check gate does not cover `.mjs` files. JSDoc types and the tests are the only guard.

- **Workspace layout is `apps/*` and `packages/*`**: The PRD names five members, not their directories. The validator reads member globs from `pnpm-workspace.yaml` rather than hard-coding paths, so a different layout only changes the manifest paths in this spec. Risk: the example paths in the spec (`packages/config/...`) go stale if TBI-001 picks other names.

- **Shared coverage floors live in a JSON data file**: TBI-023 requires floors "defined once in shared configuration". The validator cannot run TypeScript, so it needs data it can read. The contract with TBI-023 is `packages/config/coverage-thresholds.json` with the keys `lines`, `functions`, `statements`, and `branches`, imported by the shared Vitest preset. The shared file is the authority, and the manifest records a copy that the validator compares. Risk: if TBI-023 ships the thresholds in a `.ts` file only, S1 and S3 need a small conversion.

- **Member-config check is a text scan**: PBI-023 (d) requires the validator to catch a package that lowers a threshold locally. The validator scans each member's `vitest*.config.*` text. It reports an error when the file contains the word `thresholds`, or when it does not import the config package named in `packages/config/package.json`. Risk: a comment containing the word causes a false error, and a threshold set through computed code is missed. Resolving the real Vitest config would be exact but needs TypeScript execution and is slow.

- **A deferred gate may lack its script**: PBI-024 (c) and PBI-025 (a) accept a gate that "cannot run yet". Such a gate often has no script. When a gate has a complete deferral, a missing script is a warning, not an error. Without a deferral it is an error. Risk: a team could defer a gate to hide a missing script. The deferral still needs a reason and an owner, and the summary lists it as `deferred`.

- **Gates may share a script**: TBI-023 provides "a single command" for unit and component tests, so `unit` and `component` can name the same script. The validator does not require unique scripts. Risk: QA evidence for the two gates is one run.

- **Warnings never change the exit code**: Errors exit 1. Warnings (illustrative NFR values, a deferred gate's missing script) exit 0, as PBI-026 (c) says the validator "warns". Risk: a pipeline that ignores output never sees the warning.

- **"Illustrative" is a required boolean on each NFR target**: The schema requires `illustrative` on every target. The committed manifest sets it to `true` and a `description` that says the value is a format example, not a promise. A project flips it to `false` when it sets a real target. Risk: a project could flip the flag without changing the value, and the validator cannot tell.

- **Concurrency verdict**: The PRD gives no pass rule for the concurrency target. The runner reports `PASS` when the run held at least `users` virtual users and no request failed. This adds no performance number. Risk: a project that expects a failure-rate allowance needs its own rule.

- **Sample load test calls `GET /api/v1/me`**: The endpoint is real, versioned, and touches the database. The target base URL comes only from `LOAD_TEST_BASE_URL`, with no default, so a run always names its environment (PBI-026 security note). Authentication outside development mode uses an optional `LOAD_TEST_AUTH_HEADER`. Apex's own load-test module blocks production-pattern hostnames through an admin-managed allowlist. The template has no admin surface, so it prints the target and relies on the team's choice. Risk: someone points the runner at a shared environment by mistake.

- **Duplicate ids are errors**: Two gates with the same id, or two deferrals for the same gate, make the manifest ambiguous. The validator rejects both. The PRD does not say this. Risk: low.

- **Deferral owner is free text**: A name or team label. Apex has no user directory in the template. Approval workflows and expiry reminders are out of scope (PBI-025).

- **Validator never runs gates**: It checks that scripts exist. It does not execute them. So the summary shows each gate as `defined` or `deferred`, never "passed". Running gates is the job of the person or pipeline that calls the scripts. Risk: a reader may take `defined` as a pass.

- **Validator is a stand-alone script**: `quality:validate` is not folded into the `check` script from TBI-005. How teams combine scripts is their policy (BR-013). Risk: a developer who runs only `check` misses a broken manifest.

- **Quality tests run through Vitest as `test:quality`**: The tests sit in `scripts/quality/__tests__/` and extend the shared Vitest preset. The `test:unit` aggregate from TBI-023 should include `test:quality`. Risk: if TBI-023 ships a different aggregate, S7 must add the call.

- **Tests that spawn processes use fixture roots**: The validator accepts `--root <dir>`, so tests build throwaway manifests in a temp directory and never edit the committed files.
