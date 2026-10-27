# Assumptions & Unresolved Items — API-Contract and UI-Standards Skills

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** None
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

**Feature:** FEAT-015 — Epic "Agent Guidance and Knowledge Base" — work items PBI-032, PBI-033, PBI-034, TBI-035, TBI-036.

**Session note:** This run was non-interactive. The Phase 2 refinement session was skipped, so every question below carries a recommended default. The spec is written against that default. Overturning a default changes the sections named in its "Impact" line.

---

## Unresolved Items

Items that could not be inferred from the PRD, backlog, or codebase. Each must be decided before the relevant implementation step starts.

- ⚠ **Skill location and discovery path**: The backlog says both skills are "linked from the agent entry point and the agent index" (TBI-035, TBI-036) but names no directory. TBI-033 (FEAT-014) owns the knowledge-base layout and does not fix it either. **Impact:** blocks S2 and S5 in the tech spec; the path appears in the docs-validation links, the dry-run instructions, and the Apex isolation check (VT-19). **Decision needed:** confirm `templates/full-stack-express/.cursor/skills/api-contract/SKILL.md` and `templates/full-stack-express/.cursor/skills/ui-standards/SKILL.md` (recommended: it matches the `.cursor/skills/{name}/SKILL.md` layout that Apex-launched agents already resolve, and nested under `templates/` it does not alter Apex's own skill list), or name another directory. FEAT-014 and FEAT-016 must use the same answer, because the developer skill (TBI-039) links to these two paths.

- ⚠ **Owner of the undocumented-handler check**: PBI-006 (d) and PBI-032 (b) require that a handler with no route definition makes "the checks" fail and names the undocumented route. No work item builds that check. The drift check (TBI-010) compares the generated OpenAPI document with the committed one, and a handler absent from the contracts package appears in neither. The contract tests (TBI-026) cover "every route in the committed document", so they also miss it. **Impact:** `API-R01` in the `api-contract` skill has no enforcing check, and VT-06 cannot pass. **Decision needed:** assign one of these to FEAT-006 (TBI-014 or TBI-015) or FEAT-011 (TBI-026): (1) recommended: a contract test that reads the Express router's registered method and path pairs and asserts the set equals the contracts package route set, with a failure message naming the extra route; (2) a route registrar that accepts only contract definitions, so an undefined handler does not compile. Until one exists, the skill must mark `API-R01` as `Review` and VT-06 is blocked.

- ⚠ **Enforcing-check names and rule-table validation**: Every rule must "name the check that enforces it, or state that review enforces it" (TBI-035, TBI-036 NFRs). The quality manifest (TBI-027, FEAT-012) owns script names and is not yet authored. Also, the gate list in the PRD (build, type-check, lint, formatting, OpenAPI drift, migration validation, unit, component, API, integration, accessibility, container build) has no gate named "contract tests", though TBI-026 provides a single command for them. **Impact:** the "Enforced by" column of both rule tables, and VT-03. **Decision needed:** (1) confirm the contract tests run under the manifest's `API` gate or add a gate for them; (2) confirm that the docs-validation script (TBI-034) may check that each skill's rule table has a non-empty "Enforced by" cell holding either a gate ID found in the quality manifest or the literal `Review`. Recommended: yes to both. If (2) is declined, VT-03 becomes a manual reviewer check and the NFR rests on review alone.

- ⚠ **Unknown-key policy for identifier fields**: TBI-015 says a request body containing an identifier or subject field is "rejected or ignored as defined in the contract". TBI-035 requires the skill to state that "handlers must not accept another person's identifier on the profile resource". The skill cannot state the mechanism until FEAT-004 or FEAT-006 fixes it. **Impact:** wording of `API-R11` and the assertion in VT-09 (400 Problem Details versus a 200 that leaves the other person's row unchanged). **Decision needed:** recommended: strict request schemas reject unknown keys with a 400 Problem Details error, so a client learns that the field is not accepted. Confirm or choose "ignore".

---

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

- **Surface is documentation only**: FEAT-015 ships two Markdown skills inside `templates/full-stack-express/`. It adds no Apex route, service, component, shared type, or migration. Derived from the TBI-035/036 descriptions and the PRD isolation rules (BR-008). Risk if wrong: a hidden Apex change would breach the "no change to Apex runtime" rule.

- **`templates/` is new**: Listing `templates/` in the pinned checkout returned nothing, so no existing template content, skill, or index exists to extend. Risk: if FEAT-001 and FEAT-014 land in a different directory name, every path in this spec changes together.

- **Apex rules are prior art, not content**: `react-coding-standards.mdc`, `ui-design-standards.mdc`, `fullstack-node-bff/SKILL.md`, `rbac-governance.mdc`, and `postgresql-db.mdc` informed the structure only. Apex uses CSS custom properties and CSS Modules, `ensureAuthenticated`, and RBAC permission keys. The template uses MUI theme tokens, its own authentication middleware, and no RBAC. The skills must not copy Apex names, paths, or permission keys (BR-008, PBI-030 (d)). Risk: copied Apex wording would fail VT-18.

- **Transitive dependencies cover the real inputs**: FEAT-015 lists `dependsOn` FEAT-004, FEAT-009, FEAT-014. The skills also describe the profile routes (FEAT-006), the profile screen (FEAT-010), and the test gates (FEAT-011, FEAT-012). FEAT-014 depends on FEAT-012, FEAT-012 on FEAT-011, and FEAT-011 on FEAT-006 and FEAT-010, so the chain already holds, and the implementation phases place this Epic last (phase 6). Risk: if FEAT-014's dependencies change, the skills could cite files that do not exist yet. The authoring step (S1) therefore checks every cited path before writing.

- **Skill file format**: Markdown with YAML front matter holding `name` and `description`, as in Apex's `fullstack-node-bff/SKILL.md`. `disable-model-invocation` is not set, because the developer skill (TBI-039) and agents must be able to load these skills on demand. Risk: a runtime that ignores front matter loses the trigger text, but the body still reads correctly.

- **Fixed headings in each skill**: `## When to use`, `## Required references`, `## Rules`, `## Adding an endpoint` (api-contract) or `## Adding a screen` (ui-standards), `## Review checklist`, `## Stop conditions`. TBI-034 checks "required sections", so stable headings let it cover the skills. The headings are this spec's choice, since the backlog names none.

- **Rule tables use stable IDs**: Rules carry IDs `API-R01…` and `UI-R01…`, and each row has an "Enforced by" cell. IDs let the developer, QA, and integration skills (FEAT-016) cite a rule without quoting it. Risk: renumbering breaks those citations, so IDs are never reused.

- **Hard-coded color detection**: PBI-017 (d) says a hard-coded color is flagged "when I run lint or review". No work item adds a lint rule for it. The skill marks `UI-R01` as `Review` unless a lint rule exists at authoring time, in which case it names that rule. Risk: reviewers miss violations that a lint rule would catch. Adding one would fit TBI-003 (shared lint config).

- **Light and dark theme selection**: The Epic "Design System and Reference Web Client" says the selection mechanism "is chosen at implementation and documented in the ui-standards skill". The skill therefore documents whatever TBI-020 implements. It does not choose the mechanism.

- **Test selector convention is quoted, not invented**: TBI-021 defines the convention and the backlog does not name the attribute. The skill copies the convention from the UI package documentation and the profile screen. Risk: if TBI-021 and TBI-036 disagree, the component tests (which follow TBI-021) win and the skill is corrected.

- **No live list endpoint**: The reference API has no list endpoint (PRD: no user list). The pagination rule (`API-R09`) therefore cites the reusable pagination schema from TBI-011 and a worked example in the skill, not a live route. Enforcement for a real list route comes from the contract tests that every new route must add. Risk: the rule is only exercised in VT-07's scratch route.

- **Dry runs use a scratch copy**: VT-05 to VT-17 introduce deliberate violations. They run in a throwaway copy of the template and are never committed. Risk: none to the template; the cost is implementer time.

- **Immutable references**: The PRD says skills "point to immutable project references". Interpreted as repository-relative paths inside the template, which a pinned commit fixes, with no links to branches, URLs, or Apex. Risk: a reviewer may mean version-tagged links. The ADR text was not available to confirm (see PRD assumption).

- **Link edits to FEAT-014 files stay minimal**: S5 adds one link per skill to the agent entry-point document and one line per skill to the plain-text agent index. It does not restructure either file.

- **Skill size**: Each skill stays under about 300 lines so an agent loads it whole. Derived from the "plain Markdown readable by agents" NFR. Risk: a longer skill is still valid, but agents may truncate it.

- **Personas**: "Developer" includes Apex-launched development agents, "UI/UX" is the reviewer in PBI-034, and Platform Engineering maps to `Platform Admin`, as the PRD states. No new persona is introduced.

- **No feature flag, no rollout**: The PRD sets "Flag required: No". The backlog carries no `featureFlag` on FEAT-015. Apex's `feature-flags` skill does not apply.

- **Apex formatting check**: The PRD assumes Apex's root formatting check scans the whole repository. The skill files must pass it or fall under the minimal ignore entry that FEAT-001 settles. Risk: a Markdown formatting failure blocks the Apex build, which VT-19 catches.
