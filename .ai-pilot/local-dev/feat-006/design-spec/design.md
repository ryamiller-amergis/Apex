# Design — Host-Agnostic Work-Item Integrate

> **PRD slug:** `start-cloud-development-from-my-work` | **Priority:** Should Have | **Feature flag:** `my-work-cloud-agent`
> **Parent Epic:** Cloud Agent Run Outcomes | **Affected personas:** Developer
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (4 unresolved)

---

## Feature Summary

**Description:** Today, only Apex's local Start-Development sessions guarantee traceability between a pull request and its Azure DevOps work item (`createSessionPr()` in `devWorkbench.ts` already embeds an `AB#{workItemId}` mention and, for Azure Repos, a native `workItemRefs` link). Once Cloud Agent runs (FEAT-002) start opening PRs on a Developer's behalf, that same traceability guarantee must hold regardless of which code host the project is configured for. This Feature extracts and extends the existing mention/link mechanics so every Cloud Agent-produced PR carries a work-item reference the host renders natively — a GitHub `AB#` mention or an Azure Repos native work-item link — with no manual step and no new work-item type.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-009 | PBI | Have my PR automatically link to its ADO work item | Should Have |
| TBI-008 | TBI | Embed host-appropriate work-item reference at PR-creation time | Should Have |

---

## Scope and Out-of-Scope

**In scope:**
- Embedding an `AB#{workItemId}` mention in the PR title or body when a Cloud Agent's PR is opened on GitHub.
- Guaranteeing Azure Repos' native work-item-to-PR link exists when a Cloud Agent's PR is opened against an Azure Repos-hosted skill repository.
- Logging a missing GitHub `AB#` mention as a detectable defect rather than dropping it silently.
- Skipping all work-item-reference logic when a run never produces a PR — there is nothing to link.

**Out of scope:**
- Creating GitHub Issues (Feature, Epic)
- Syncing comments between the git host and Azure DevOps (Feature, Epic)
- Editing an existing PR's title/body after creation to add a missing reference (PBI-009) — a missing GitHub mention is logged, not patched
- An in-app PR review experience, reviewer votes, or a complete-PR action inside Apex (Epic, top-level PRD)
- Full Azure DevOps pull-request lifecycle in Apex beyond the reference itself (top-level PRD)

---

## Target Surface

**Primary surface:** Backend only (Express server / service layer)

**Experience notes:** Not applicable. This Feature's parent PRD is full-stack overall, but PBI-009 itself surfaces nothing new in Apex's UI — the work-item reference lives entirely in PR title/body text on the git host, or in Azure Repos' own native work-item-link UI. PBI-009's own accessibility requirement confirms this: "Not applicable — the work-item reference lives in PR title/body text on the git host, not in Apex UI."

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Embed/verify the work-item reference at PR-creation time | No user action — triggered internally by the Cloud Agent completion path (FEAT-001's webhook completion receiver), never called directly | Project-scoped (bound to the run's project and configured skill repository) |
| View the resulting PR / work-item state | Developer group + `dev-workbench:view`, self-only (inherited unchanged from FEAT-002/FEAT-004 — this Feature adds no new read surface) | User-scoped (self-only) |

**Feature flag:** `my-work-cloud-agent` — rollout: Internal → Beta → GA (Apex/internal first, then gradual project targeting)
**Behavior when flag is off:** No Cloud Agent runs are launched, so this Feature's PR-creation step never executes. The existing local-dev PR flow (`createSessionPr` in `devWorkbench.ts`) is unaffected and keeps behaving exactly as it does today.

---

## Acceptance Criteria

### PBI-009 — Have my PR automatically link to its ADO work item

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | the code host is GitHub | the Cloud Agent opens a PR | the PR title or body includes the `AB#` work-item mention |
| (b) Error/failure | the `AB#` mention is missing from a PR that should have one | the PR is inspected | this is treated as a defect — the mention is always attempted at PR-creation time and its absence is logged |
| (c) Edge case/boundary | the code host is Azure Repos | the Cloud Agent opens a PR | it uses Azure Repos' native work-item link instead of an `AB#` mention |
| (d) Negative scenario | a run that never opens a PR | the work item is inspected | no work-item link is created, since there is no PR to link |

---

## UI/UX

Not applicable. This Feature is backend-only — no new route, component, or `data-testid` is introduced. The resulting work-item reference is visible only on the git host (PR title/body on GitHub, or the native "Linked work items" panel on an Azure Repos PR) and, for the ADO work item side, through the existing PR-link surfacing already delivered by FEAT-004 (ADO PR Status on My Work).

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
