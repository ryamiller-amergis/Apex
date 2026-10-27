# Design — Platform Engineering Handoff Package

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Agent Guidance and Knowledge Base | **Affected personas:** Platform Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (6 unresolved)

---

## Feature Summary

**Description:** Platform Engineering must decide whether to adopt the Full-Stack Express Starter Template into its bootstrap source. To decide, its reviewers need one document that states what the template provides, what Platform Engineering owns, which contracts Platform Engineering's pipeline consumes, and which decisions the template leaves open. This Feature writes that document, `templates/full-stack-express/docs/handoff.md`, and makes the documentation validation reject it when it names a script, manifest, endpoint, environment variable, or extension point that does not exist. At the end state, a reviewer reads one file and can name the owner of AWS infrastructure, pipelines, migration execution, deployment packaging, and repository governance, and can list all five open decisions with the file or interface each one plugs into.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-042 | TBI | Write the handoff document | Must Have |
| PBI-040 | PBI | Review what the template provides and what Platform Engineering owns | Must Have |
| PBI-041 | PBI | See the unresolved decisions and the extension points they affect | Must Have |

**Dependencies:** FEAT-013 (Supply-Chain Baseline and Production Container) and FEAT-014 (Docs-as-Code Knowledge Base). The document also names artifacts from FEAT-001 through FEAT-012, and from FEAT-008, which the backlog does not list as a dependency (see ⚠ in the assumptions file).

---

## Scope and Out-of-Scope

**In scope:**
- One Markdown handoff document with four required sections: ownership table, contracts Platform Engineering consumes, replacement placeholders, and unresolved-decision register.
- An ownership table that names an owner for AWS infrastructure, pipelines, migration execution, deployment packaging, and repository governance.
- A contracts table that lists scripts, manifests, health endpoints, environment variables, the migration command, and the container definition, each resolved against the template.
- A placeholder list for project name, package scope, service name, and database name.
- A register of five unresolved decisions (production identity provider, RBAC, data classification, NFR targets and test execution policy, feature-flag provider), each with its extension point.
- Registering the document with the knowledge base: a link from the agent entry-point document, a line in the plain-text agent index, and its required headings in the validator.
- Validator rules that reject unresolved contract names, empty owners, empty extension points, and absolute URLs to hosts outside a short local list.
- Tests for each rule.

**Out of scope:**
- Bootstrap or provisioning automation, and any Apex integration with Azure DevOps repository creation.
- Apex root workspace integration.
- Resolving the open decisions. The register lists them; Platform Engineering decides them.
- Tracking decision status over time.
- Bootstrap implementation and an approval workflow for adopting the template.
- AWS infrastructure as code, ECS configuration, CI/CD pipeline definitions, image publishing, and deployment stages (Platform Engineering).
- Repository governance files (Platform Engineering).
- An Apex screen, menu entry, route, or permission for viewing the document (see ⚠ in the assumptions file).
- Any change to Apex runtime behavior, its database, or its services.

---

## Target Surface

**Primary surface:** Full-stack (the PRD's template-wide surface). This Feature ships documentation and a validator rule only; it changes no client or server code of either the template or Apex.

**Experience notes:** The template is a standalone starter repository, not an Apex screen, and has no Apex navigation entry. The reader experience is a Markdown file read in the repository, with headings and plain tables that assistive tools and agents can read. The same file feeds the FEAT-016 integration skill, which reads the register to list open decisions.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Review the template in Apex and move it to the bootstrap source | Platform Engineering (mapped to `Platform Admin` in the backlog) | Global |
| Read the handoff document | Anyone with read access to the repository, including `Developer` and Apex-launched agents; the template defines no roles | No restriction |
| Run the documentation validation | `Developer`, locally; Platform Engineering's pipeline, if it chooses | No restriction |
| Role-based authorization in generated apps | Not defined; an extension point for Platform Engineering, recorded in the register | Not applicable |

The Feature adds no Apex permission key and no `can()` guard. Platform Engineering is not an Apex persona, so access to the document is repository access, not an Apex role.

**Feature flag:** `None` — rollout: Not applicable (a reviewable sample that does not change Apex runtime behavior)
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

Rows marked *derived* have no counterpart in the backlog. The backlog gives four criteria per PBI and none is a negative case, so this design adds one per PBI. See the assumptions file.

### PBI-040 — Review what the template provides and what Platform Engineering owns

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path — ownership | I open the handoff document | I read the ownership table | Each of AWS infrastructure, pipelines, migration execution, deployment packaging, and governance has a named owner |
| (a2) Happy path — placeholders | I want to start a project from the template | I read the placeholder section | I find the list of replacement values for project name, package scope, service name, and database name |
| (b) Error/failure | A document claims a contract that does not exist | I run the documentation validation | The validation reports the stale reference |
| (c) Edge case/boundary | The document names a script, manifest, or endpoint | I look for it in the template | It exists (this holds for every contract kind: script, manifest, endpoint, environment variable, migration command, and container definition) |
| (d) Negative scenario (*derived*) | An ownership row has an empty owner, or an owner other than `Template` or `Platform Engineering` | I run the documentation validation | It exits non-zero and names the row |

### PBI-041 — See the unresolved decisions and the extension points they affect

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path — register | I open the unresolved-decision register | I read it | It lists the production identity provider, RBAC, data classification, NFR targets and test execution policy, and feature-flag provider |
| (a2) Happy path — extension points | A decision is listed | I read its entry | It names the adapter, manifest, or interface that the decision plugs into |
| (b) Error/failure | A listed extension point has no matching interface or file in the template | I run the documentation validation | The validation reports the stale reference |
| (c) Edge case/boundary | I open the data classification entry | I read it | It states that synthetic fixtures and identity redaction are engineering practice, not a classification, and it assigns no classification level |
| (d) Negative scenario (*derived*) | A register row has an empty extension-point cell | I run the documentation validation | It exits non-zero and names the decision |

### TBI-042 — Write the handoff document

TBI-042 has no user story. Its definition of done maps to the rows above:

| Definition of done | Covered by |
|--------------------|-----------|
| The ownership table covers AWS infrastructure, pipelines, migration execution, deployment packaging, and repository governance | PBI-040 (a) |
| The document lists scripts, manifests, health endpoints, environment variables, the migration command, and the container definition | PBI-040 (c) |
| The register lists the five decisions, each with its extension point | PBI-041 (a), (a2) |
| The documentation validation passes for the document | PBI-040 (b), PBI-041 (b) as the failing cases, and the passing run in VT-01 |

---

## UI/UX

Not applicable. This Feature builds no screen, route, or component, so there are no `data-testid` attributes, loading states, or form validation.

**Document structure (what a reviewer sees):**

| Section heading | Purpose | Format |
|-----------------|---------|--------|
| `## What the Template Provides` | Two to six bullets: the modules, scripts, manifests, and container a project receives | Bulleted list |
| `## Ownership` | Who owns each area | Table: `Area`, `Owner`, `What the template ships`, `What Platform Engineering does` |
| `## Contracts Platform Engineering Consumes` | Everything the pipeline calls or reads | Table: `Kind`, `Identifier`, `Purpose`, `Source in the template` |
| `## Replacement Placeholders` | Values to replace when starting a project | Table: `Placeholder`, `Meaning`, `Where it appears` |
| `## Unresolved Decision Register` | Open decisions and their extension points | Table: `Decision`, `Extension point`, `Template behavior until decided`, `Decision needed from Platform Engineering` |

**Validation rules (enforced by the documentation validation script):**
- Every required heading above is present, in any order.
- `Ownership`: every row has an `Owner` of exactly `Template` or `Platform Engineering`.
- `Contracts`: every `Identifier` resolves against the template for its `Kind`.
- `Unresolved Decision Register`: every row has a non-empty `Extension point` that resolves to a file or interface in the template, and the five named decisions are present.
- The file contains no absolute URL to a host other than `localhost`, `127.0.0.1`, or an `example.*` domain.

**Accessibility:**
- Use real headings in order (`#`, then `##`) and plain Markdown tables with a header row. Do not use HTML, images, or merged cells.
- Write link text that describes the target, not "here".
- Each table cell holds one fact, so a screen reader reads a row in a useful order.

**data-testid attributes:** Not applicable.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
