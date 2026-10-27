# Design — Docs-as-Code Knowledge Base

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Agent Guidance and Knowledge Base | **Affected personas:** Developer
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (4 unresolved)

---

## Feature Summary

**Description:** Teams that start a project from the template, and the agents that build for them, have no stable place to learn how the project is laid out. This Feature gives them one entry point (`AGENTS.md`) that links the architecture, module maps, API documentation, runbooks, and testing guidance, plus a plain-text index for agents. A validation script (`pnpm docs:check`) reports broken links, missing required sections, and stale paths, so agents never act on outdated instructions. No wiki service runs; every document is Markdown or text in the repository.

**Depends on:** FEAT-004 (Zod-Authoritative API Contract), FEAT-009 (Neutral MUI Design System and App Shell), FEAT-012 (Quality Manifest and NFR Manifest). It documents what those Features build.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-033 | TBI | Author the knowledge base structure and agent index | Must Have |
| TBI-034 | TBI | Add the documentation validation script | Should Have |
| PBI-030 | PBI | Find architecture, module boundaries, and runbooks from one index | Must Have |
| PBI-031 | PBI | Detect broken links, missing sections, and stale paths in documentation | Should Have |

---

## Scope and Out-of-Scope

**In scope:**
- Agent entry-point document `AGENTS.md` that links every other document and the agent index (TBI-033).
- Architecture documentation, an ADR area (index, MADR template, records of decisions the PRD already makes), module map, API documentation, runbooks (local setup, migrations, common failures), testing guidance, design-system reference, and component catalog (TBI-033).
- A place for the compatibility table (`docs/compatibility.md`, content from TBI-002) and its entry in the index.
- A plain-text agent index that lists every document (TBI-033, PBI-030).
- `scripts/check-docs.mjs`, its JSON config, and the `docs:check` script. It checks internal links, required sections, stale paths, index coverage, and module-map coverage (TBI-034, PBI-031).
- Unit tests that prove each check through exit status and reported findings.

**Out of scope:**
- Generated static documentation site (Feature).
- Embedding or vector search (Feature).
- Search service (PBI-030).
- Generated site (PBI-030).
- Prose quality checks (PBI-031).
- Spell checking (PBI-031).
- Fetching or checking external links; the validator skips them (PBI-031 acceptance criterion).
- Validating `#fragment` anchors inside internal links (see assumptions).
- A runtime searchable wiki, runtime AI or LLM services, and model dependencies (Epic, PRD).
- Repository governance documents such as contribution guides and code owners (Epic, PRD).
- The `api-contract`, `ui-standards`, and five role skills (FEAT-015, FEAT-016). This Feature only links and indexes them.
- The Platform Engineering handoff document (FEAT-017). It reuses `docs:check` and appends its own entries to the config.
- Apex-specific code or content (BR-008), except one explicit note about the template's origin.
- Secret scanning of documents (FEAT-013).
- Checking that prose is factually correct beyond links, headings, paths, and index coverage.

---

## Target Surface

**Primary surface:** Full-stack, as the PRD states for the template. This Feature adds no client or server runtime code. It adds Markdown, one text index, one JSON config, and one Node command-line script inside `templates/full-stack-express/`.

**Experience notes:** The reader opens `AGENTS.md` in a repository viewer or an editor, or an agent reads it as plain text. The template is a standalone starter repository with no Apex navigation entry. The validator prints plain text, one problem per line.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Read the knowledge base documents and agent index | Anyone with read access to the generated project's repository. The template defines no roles (BR-003). | No restriction |
| Run `pnpm docs:check` | Any Developer or agent with a checkout. No authentication; the script reads local files only. | No restriction |
| Edit documents and `docs/docs-check.config.json` | A Developer through the generated project's normal repository change flow. Branch policy belongs to Platform Engineering. | Project-scoped (the generated application's repository) |
| Review the template in Apex and move it into the bootstrap source | Platform Engineering, mapped to `Platform Admin` in the backlog | Global |

**Feature flag:** `None` — rollout: Not applicable. The PRD sets `Flag required: No`.
**Behavior when flag is off:** Not applicable.

---

## Acceptance Criteria

Scenario IDs `(a)` to `(d)` match the verification test matrix in the technical specification.

### PBI-030 — Find architecture, module boundaries, and runbooks from one index

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I open the entry-point document | I look for module maps, API docs, runbooks, and testing guidance | Each is linked and the agent index lists them all |
| (b) Error/failure | A link in the entry-point document points to a missing file | I run the documentation validation | The broken link is reported |
| (c) Edge case/boundary | A new module is added without a module map entry | I run the documentation validation | The missing entry is reported |
| (d) Negative scenario | I search the documents for Apex-specific names or paths | I review the results | None appear outside an explicit note about the template's origin |

### PBI-031 — Detect broken links, missing sections, and stale paths in documentation

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | All documents are consistent | I run the documentation validation | It exits zero |
| (b) Error/failure | A document refers to a file path that was renamed | I run the validation | It exits non-zero and names the document and the stale path |
| (c) Edge case/boundary | A runbook is missing a required section heading | I run the validation | It exits non-zero and names the runbook and the section |
| (d) Negative scenario | A link points to an external address | I run the validation | The external link is not fetched and is not reported as broken |

**Technical work items.** The definition of done for each is verified through the scenarios above and the VT rows in the technical specification:

| TBI | Definition of done, summarized | Verified by |
|-----|-------------------------------|-------------|
| TBI-033 | Entry point links every document and the index; each module has a map entry naming responsibility and public interface; runbooks cover local setup, migrations, common failures; design-system reference and component catalog match the UI package; all documents are plain Markdown or text | PBI-030 (a), (c); VT-01, VT-03, VT-16 |
| TBI-034 | Broken links, missing sections, stale paths, and documents absent from the index are each reported; the script exits non-zero and names each problem | PBI-031 (a) to (d); VT-02 to VT-14 |

---

## UI/UX

Not applicable. This Feature adds no screen, route, component, or `data-testid`. Reader-facing requirements (headings, descriptive link text, plain-text output) appear in the acceptance criteria above and in the technical specification.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
