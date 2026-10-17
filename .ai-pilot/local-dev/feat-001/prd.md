<!-- apex-grounded-sha:f1fe8d46ed081e310bdb95b66063a80cd987e243 -->

> Based on the **Apex** project, **main** branch, as of Oct 16, 2026.
---
title: Human Workflow Evaluation for Interviews and PRDs
slug: human-workflow-evaluation-for-interviews-and-prds
created: 2026-10-16
triage-status: needs-triage
glossary-terms-used:
  - Interview
  - PRD
  - Backlog
  - PBI
  - TBI
  - Skill
  - RBAC
  - Feature Flag
  - Project Admin
  - Platform Admin
  - Apex (project)
---

# Human Workflow Evaluation for Interviews and PRDs

## Problem Statement

Apex generates Interview context and PRDs with AI skills, but it has no structured way to learn whether people judged that output good. PRD review today gives only approve or request revision, plus inline comments. It records no scores, no reasons, and no copy of what the reviewer wanted instead. Automated PRD validation checks structure, not whether the PRD captured the intended problem. Without reviewer signal that is stored per skill version, model and artifact version, the AI orchestration stays static and cannot show measured improvement.

## Solution

At the end of each Interview phase and on PRD review, a reviewer can score the AI output on five criteria, pick an outcome, give reasons for low scores, and supply a corrected version. Each submission becomes an immutable evaluation event tied to the skill version, model, project and exact artifact version. Every submission also starts two background checks, a Promptfoo run and an LLM judge run, whose results sit next to the human scores as diagnostic evidence. Project Admins review outcomes and recommended improvements in Admin. Platform Admins see a cross-project hub. The whole feature is optional feedback: it never blocks Interview progress, PRD generation or approval. It ships behind a Feature Flag, starting with the Apex (project) and named pilot projects.

## Implementation Decisions

**Modules to build**

- **Workflow evaluation service (deep module).** One service owns the evaluation plane. Its interface takes a validated human submission and returns the stored event. Its other operations are: read active definitions, list events for a subject, and read one event with job status. It owns all submission rules:
  - Validate that all five criteria are scored 1–5 and that the outcome is one of accept unchanged, accept after edits, regenerate or reject.
  - Require reason codes and a minimum-length comment when any criterion is 2 or lower.
  - Require a corrected artifact when a PRD outcome is accept after edits.
  - Resolve reviewer role.
  - Resolve lineage (skill path, skill version, model, interview and PRD ids) on the server. The client never supplies lineage.
  - Write large corrected artifacts to Blob and keep a reference on the event.
  - Insert the event append-only. Events have no update or delete operation.
- **Artifact binding resolver (deep module).** Computes the content hash that ties an event to the exact artifact the reviewer saw. For a PRD, the hash covers the PRD markdown plus a canonical form of the backlog JSON. For an Interview phase, it covers that phase's transcript slice plus the linked context used at phase end. Judges and Promptfoo runs receive the same hash. A generation counter is stored alongside the hash only where Apex already has one.
- **Diagnostic job orchestrator (deep module).** On every human submission it creates exactly two jobs for the event, one Promptfoo run and one LLM judge run, and enqueues each through the existing V2 admission pattern. App Service builds an immutable execution specification for each run. The specification carries a redacted artifact package (the excerpt, backlog slice and transcript context the judge needs), the rubric version, the suite reference, the artifact hash, the judge model, and the human scores as reference hints. Per the V2 worker rule, App Service resolves every value and the worker holds no default. Job status is pending, running, ready or failed. Manual retry of a failed job is the only retry path. Reading an event never enqueues work.
- **Promptfoo executor and LLM judge executor (V2 worker side).** The Promptfoo executor runs the suite named on the specification and returns a summary. The judge executor returns structured JSON that matches the schema in the definition (missed requirements, invented requirements, optional alignment score, recommended improvements, confidence), plus a markdown appendix. Full outputs go to Blob. A judge response that fails schema validation marks the job failed.
- **Definitions registry (data and seeds).** Platform-seeded, versioned rows keyed by process, stage, evaluator and benchmark. Each row holds criteria labels and help text, reason codes, allowed outcomes, allowed reviewer roles, the Promptfoo suite reference, the judge output schema, and an active flag. Seeds cover the PRD human review stage and three Interview phase stages. A one-phase Interview uses only the first phase stage. All stages share the same five criteria keys: intent alignment, requirements coverage, scope alignment, acceptance criteria and readiness. Labels and help text differ per stage.
- **Dedicated workflow evaluations router.** One router serves every subject type so later processes (design docs, prototypes) reuse it. Operations:
  - Read definitions.
  - List events filtered by project, subject type and subject id.
  - Create an event.
  - Read one event with job status.
  - Retry a failed job.
  - Admin list, export and cross-project aggregate.
  
  All operations require the Feature Flag to be on for the project.
- **Thin hooks in the Interview and PRD services.** They supply lineage inputs, the artifact content for hashing, and the phase count and current phase. They add no approval or phase gate. Document approval and owner approval services are not changed.
- **Shared feedback UI.** A definition-driven feedback form, a history list and TanStack Query hooks, reused by the PRD review view and the Interview chat view. Behavior:
  - The form shows the five criteria on a 1–5 scale (missed, major changes needed, some changes needed, minor changes needed, met completely).
  - The form shows reason codes and requires a comment when any score is 2 or lower.
  - The form shows the derived reviewer role, or a picklist when it is ambiguous.
  - History defaults to events whose hash matches the live artifact, with a control to show older versions.
  - A prompt controller shows a dismissible modal the first time a stage has no event for the subject, then a persistent Quality feedback tab or panel, and a light banner until someone submits or dismisses it for the session.
- **PRD review surface.** A Quality feedback tab inside the existing PRD review view. For accept after edits, it captures a snapshot of the current PRD markdown and falls back to pasted text when the PRD was not edited in Apex.
- **Interview surface.** A Quality feedback panel on the Interview chat view at the end of each phase, with an optional field for a corrected phase summary.
- **Project Admin outcomes screen.** A new Workflow evaluations page in Admin, shown only when the flag is on for the project. It lists and filters events and shows an event detail drawer. The drawer prefers the judge's recommended improvements, shows the markdown appendix, and shows a separate badge when the Promptfoo run failed. It also offers JSON and CSV export and a retry control for failed jobs. It is read-only otherwise: no skill promotion or skill edits.
- **Platform Admin hub.** A cross-project list in Platform Admin with project, stage, outcome counts and recent regenerate and reject events. A row opens the same per-project detail view that Project Admins use.
- **Alerts.** An in-app notification to Project Admins when an event has outcome regenerate or reject. It carries the stage, the outcome, an optional comment excerpt and a link to the filtered Workflow evaluations page. It follows the existing per-type notification preferences. Job completion sends no alert.

**Schema changes**

- Workflow evaluation definitions: process key, stage key, evaluator key, benchmark key, version, rubric JSON, Promptfoo suite reference, judge output schema, active flag.
- Workflow evaluation events: one immutable row per human submission. It holds project id, definition version references, subject type (interview phase context or PRD), subject id, reviewer user id, reviewer role key and label, indexed lineage columns (skill path, skill version, model, interview id, PRD id), stage key, phase index, artifact content hash or context hash, criteria scores, outcome, reason codes, comment, and an optional corrected artifact Blob reference.
- Workflow evaluation jobs: one row per event and evaluator, unique on that pair. It holds the V2 run id, status, specification hash, summary, and result Blob references.
- No new columns on PRDs or Interviews. Authoritative history lives only in the events table. A denormalized pointer can be added later if list latency requires it.

**API contract intent**

- Create takes subject type, subject id, stage key, criteria, outcome, reason codes, comment, reviewer role (only when ambiguous) and an optional corrected artifact. The server fills lineage and the artifact hash.
- List is newest first, capped at about 50 events per subject, with a flag to include events for older artifact versions.
- Admin list, export and aggregate are separate from the reviewer operations and have their own access checks.

**Interaction notes**

- Automated validation stays in the document validation service and binary approval stays in the document approval service. Neither calls the evaluation service.
- Failure of a job or of notification dispatch never fails or changes the stored human event.
- Resubmitting creates a new event and a new pair of jobs. The UI highlights the latest event for the current artifact hash.
- Token and cost usage for both job types is logged through AI usage tracking and tied to the event id.
- The judge model is the project's evaluation model when set, otherwise the same default as PRD automated validation. Reviewers do not choose it.

## Testing Decisions

- **What makes a good test here:** Test observable behavior only. A submission with invalid or missing fields is rejected with a clear error. A valid submission stores one immutable event with server-resolved lineage and the right hash. Exactly two jobs follow each submission. Nothing in Interview or PRD flow is blocked by missing, low or reject-style feedback. Users without the permission, or projects without the flag, cannot read or write.
- **Modules to test:**
  - Workflow evaluation service — rules for scores, low-score reasons, accept-after-edits artifact, role derivation, append-only behavior and project scoping.
  - Artifact binding resolver — same input gives the same hash, any change to PRD markdown, backlog or phase context changes it, and key order in the backlog JSON does not.
  - Diagnostic job orchestrator — two jobs per event, the unique pair rule, specification contents including resolved judge model, enqueue failure leaving the event intact, manual retry only, and no enqueue on read.
  - V2 worker executors — refuse a specification with a missing required value, hold no database import, and mark a schema-invalid judge response as failed.
  - Router — permission and flag checks, project isolation, filter and cap behavior, and admin access (project Admin access or Platform Admin).
  - Feedback form and prompt controller — conditional reason and comment rules, role picklist only when ambiguous, modal shown once per stage, and skip leaves the workflow usable.
  - Admin screen, hub, export and alerts — filters, JSON and CSV content, hub counts, and notification sent only for regenerate and reject.
- **Prior art:** The PRD automated validation flow (async job with status polling), the V2 specification parity tests that drive one fixture through both transports, the worker no-database-import test, permission middleware tests for new RBAC keys, and existing notification type tests. Promptfoo suites referenced by definitions act as regression checks for the judge itself.

## Target Surface

- **Primary surface:** Full-stack (both client and server)
- **Experience notes:** Reviewer feedback sits inside the existing PRD review view and Interview chat view. Project Admins use a new Workflow evaluations page under Admin. Platform Admins use a hub in Platform Admin. Feedback is always optional and skippable.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| View definitions, event history and job diagnostics on an artifact | `workflow-evaluation:view` (default grants for Product-Owner, BA, Manager, Developer) | Project-scoped |
| Submit a human evaluation | `workflow-evaluation:submit` (default grants for Product-Owner, BA, Manager, Developer); help text names the Interview initiator and PRD owner as expected submitters, but the server does not enforce it | Project-scoped |
| Open the Workflow evaluations page, filter events, read judge recommendations | Anyone who can open Project Admin for the project, or Platform Admin | Project-scoped |
| Export events as JSON or CSV | Anyone who can open Project Admin for the project, or Platform Admin | Project-scoped |
| Retry a failed diagnostic job | Anyone who can open Project Admin for the project, or Platform Admin | Project-scoped |
| View the cross-project hub | Platform Admin | Global |
| Receive regenerate and reject alerts | Project Admins of the project | Project-scoped |

---

## Security and Data Sensitivity

- **Sensitive fields:** Free-text comments, corrected artifact markdown, and job outputs that quote PRD sections, backlog rows or Interview transcript text. None are classified beyond normal Interview and PRD content.
- **Handling requirements:** None beyond existing project controls. No separate redaction pipeline, retention rule or export restriction in v1. The data carries the same project boundary and permission model as PRDs and Interviews. The package sent to the worker is limited to the excerpts the judge needs.
- **Data scope enforcement:** Every event, job and export is keyed by project id. The server takes the project from the session and checks it on every read and write. Only the Platform Admin hub spans projects.

---

## Non-Functional Requirements

- **Response time:** Human submit returns within 2 seconds. Promptfoo and judge runs complete best-effort in the background, typically within minutes, with no hard SLO. Failed jobs are retried manually.
- **Concurrency:** Low volume. No specific concurrent-user target. Two background jobs per submission are expected to double worker traffic on busy review days, and cost is logged for review.
- **Data volume:** History lists show up to about 50 events per subject with no pagination in v1.

---

## Feature Flag

> **Authoritative for backlog `featureFlag`.** If **Flag required: No**, the backlog must **not** include a `featureFlag` property on any Feature. If **Flag required: Yes**, every affected Feature in the backlog must include `featureFlag.name` matching this section.

- **Flag required:** Yes
- **Flag name:** workflow-human-evaluation
- **Rollout sequence:** Internal → Beta → GA (on first for the Apex (project) and named pilot projects, then widened through Platform Admin targeting)
- **Kill switch owner:** Platform Admin
- **Behavior when disabled:** No Quality feedback tab, panel, modal or banner appears. The Workflow evaluations page and the Platform Admin hub are hidden. The evaluation routes refuse requests and no jobs start. Interview, PRD review and approval work as they do today. RBAC permissions still apply when the flag is on.

---

## Out of Scope

- Any gate on Interview phase advance, Generate PRD, reviewer approval or owner final approval. Feedback is advisory in v1.
- Automatic PRD regeneration or a status change when an outcome is regenerate or reject. These outcomes are captured only.
- SkillOpt, skill promotion, automatic skill edits and versioned Promptfoo benchmark dataset publication.
- Per-project rubric forks and project-setting toggles for required stages.
- Teams notifications and digest notifications.
- An advisory skill that suggests scores.
- Aggregate analytics beyond the hub's outcome counts and the CSV criteria averages.
- Evaluation of Design Docs, Design Prototypes, Agent Home and other processes.
- Automatic retry of failed jobs and per-project caps on judge runs.
- New columns on PRDs or Interviews, such as a latest-review pointer.
- Data classification, redaction pipelines and retention rules for evaluation data.

## Assumptions Made

- Gating is advisory. The transcript first asked for required rubrics at Interview phase ends and PRD owner sign-off, then asked for optional feedback and no hard block. The final lock is fully advisory, so the earlier requirements about who must submit are treated as who the product nudges.
- "Super Admin" wording maps to Platform Admin. Reviewer personas are Product-Owner, BA, Manager and Developer, the groups that receive default view and submit grants. QA can be granted the permissions but is not a default.
- The Interview initiator is a BA, Product-Owner or Manager, the groups allowed to start Interviews. The PRD owner is the document owner and is treated as a Product-Owner for persona purposes.
- The exact mapping of default grants for the two new permissions to RBAC roles is confirmed during implementation under the RBAC governance rule.
- The minimum comment length for low scores lives in the definition. A seed value of 20 characters is assumed and needs confirmation.
- Apex already tracks the Interview phase count (1 or 3) and current phase. If it does not, the Interview hook derives them from existing Interview state without adding columns.
- No PRD generation counter is assumed. The artifact hash alone binds an event to a PRD version.
- The Project Settings evaluation model may not exist yet. v1 uses it only when present and otherwise falls back to the PRD validation default. v1 does not add a new project setting.
- Failed-job retry is open to the same people who can open the Workflow evaluations page.
- Alerts go to Project Admins only. Platform Admins are included only if Apex already sends them cross-project admin alerts.
- Dismissal of the modal and banner is remembered per user in the browser. A new browser may show the modal once more.
- The seeded Promptfoo suite references start with a minimal structural check of the artifact against the rubric. Richer suites follow after the first pilot.
- Registry keys follow the accepted Measured Improvement Loop ADR, with process key `orchestrated_workflow` and stage keys for the PRD and each Interview phase.
- Corrected artifacts and job outputs are stored in Blob following the existing async infrastructure pattern.
