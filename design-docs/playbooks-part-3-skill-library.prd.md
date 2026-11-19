---
title: Playbooks Part 3 — Skill Library and Skill Contracts
slug: playbooks-part-3-skill-library
created: 2026-11-13
triage-status: needs-triage
glossary-terms-used:
  - Playbook
  - Skill
  - Platform Admin
  - Project Admin
---

# Playbooks Part 3 — Skill Library and Skill Contracts

## Problem Statement

A Playbook skill is a file in the Apex repo. Every project is offered the same foundation skills, and a project cannot change those files. A project has nowhere to keep a skill that belongs only to it. The MaxView incident investigation skill is one of those: it names MaxView systems, but it sits in the shared foundation directory, so every project is offered it. The builder's skill control is one searchable list. Foundation skills plus each project's own skills will make that list too long to scan as a single list. A person can talk to an interview step, but an ordinary agent task always runs in the background.

## Solution

Foundation skills stay files in `foundation-skills/foundation/`. Every project can select them, and no project can edit them. They are not copied into the version store. Each project also has its own skill library. Skills a project writes are stored there as versions. The MaxView incident investigation skill is the only existing skill that moves: it leaves the foundation directory and becomes a MaxView project skill, guide and catalog included. The builder's skill control shows two groups, Base skills and This project, with search across both. An agent task whose skill is interactive opens a chat in the run view, and the run continues only after the assignee approves a valid result.

## Implementation Decisions

- A skill version store (deep module) saves project skills and their companion files as versions that never change. A draft is a separate record. Foundation skills are not stored there.
- Publish of a project skill freezes that version and a bundle hash that covers the skill text and the instruction files. Reference files are not in that hash. A Playbook that names a foundation skill keeps today's path and single-file hash. Editing a foundation file can still make that published Playbook fail its check. That is accepted. Those files are not copied into the store to avoid it.
- The one move is the MaxView incident skill. Its current bytes are saved as MaxView's project skill, then it is no longer offered as a base skill. A published Playbook that still names one of the old incident paths resolves to that MaxView skill. No other existing skill file is copied.
- The run worker checks the hash it is given. It does not decide which file is reference data. The application resolves a project skill's reference files once per run and records the version it used.
- Frontmatter is parsed as YAML. Skill type and output kind live under metadata. The existing capability list stays where published files already have it. Type and kind are copied to columns so the picker can filter. The file bytes remain the source of truth.
- The skill control groups Base skills and This project. Search matches the name and the description in both groups. The closed control shows the skill name and its group. The panel scrolls. A foundation skill has no edit action there.
- Output kinds are a fixed set. Each kind's result includes the fields an agent task already returns, plus the kind's own fields. Publish rejects a binding to a field the kind does not return.
- The interactive step is a new registered step type. Each turn is an agent run on that step's thread and is checked against the policy frozen at publish. The chat is shown in the run's suspension panel.
- A project setting stores the reader identity used by skills that need a read-only cloud shell. The run specification carries that identity. The worker has no fallback identity.
- New permissions cover viewing skills, authoring project skills, and approving reference files. The existing author permission is reused. A project cannot edit a foundation skill, and cannot publish a project skill that reuses a foundation skill name.

## Testing Decisions

- **What makes a good test here:** A published Playbook that names a foundation skill still checks that file. A published Playbook that names a project skill keeps the bytes it pinned after the project edits the skill. The MaxView incident skill is selectable by MaxView and is absent from other projects' base skills. An author can find a skill by typing when both groups are long. An interactive step does not resume on output that fails its kind.
- **Modules to test:**
  - Skill version store — project-skill versions are immutable and a draft does not change a published pin. Foundation files are not inserted.
  - Publish and run policy — a project skill's bundle hash matches for instruction files and ignores reference files. A foundation path keeps the single-file hash.
  - Incident move — the three old incident paths on a MaxView Playbook resolve to the MaxView project skill.
  - Skill control — base skills and this project's skills are separate groups, and search filters both.
  - Interactive step — a proposal is hidden until it is valid, and a cancelled run leaves no result.
  - Library permissions — reference-file contents are hidden from view-only users, and an author cannot approve their own version.
- **Prior art:** Playbook publish guards and the existing agent-run policy checks. Interview suspension, deadline, and cancel behavior. Permission checks on project-scoped admin pages.

## Target Surface

- **Primary surface:** Full-stack (both client and server)
- **Experience notes:** The Skill Library is a project page shown only where Playbooks are enabled. The builder's skill control is the existing searchable picker, extended with two groups. The interactive chat appears inside the run the person already has open. A Playbook author sees names, types, and kinds.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| See skill names, types, and kinds in the Playbook builder | Playbook author | Project-scoped |
| Open the Skill Library and read instruction files | Skill viewer | Project-scoped |
| Create a project skill and edit its drafts | Skill author (existing manage permission) | Project-scoped |
| Read or approve reference-file contents | Skill author, or reference approver | Project-scoped |
| Approve a reference file when the project has no second approver | Platform Admin | Global |

---

## Security and Data Sensitivity

- **Sensitive fields:** Reference files may hold subscription and workspace identifiers. They must not hold secrets. Reader identity client IDs are configuration, not skill text.
- **Handling requirements:** Reference-file contents are excluded from view-only library responses. Run output is not filtered. Approving a reference file is recorded with the approver, and the author of that version cannot be the approver.
- **Data scope enforcement:** Project skills and their companion files belong to one project. Foundation skills are readable by every project that can use Playbooks. A run reads another project's skill only when that skill was moved for that project, as with the MaxView incident skill.

---

## Non-Functional Requirements

- **Response time:** Saving a skill draft and opening the library complete within 2 seconds at P95. Generating a draft may take longer and shows progress.
- **Concurrency:** Two approvers cannot approve the same draft version. The incident move runs once.
- **Data volume:** A project skill file or companion file over 200,000 bytes is rejected on save or approval. The skill control stays usable when a project has dozens of skills besides the foundation list: the panel scrolls and search narrows both groups.

---

## Feature Flag

- **Flag required:** No
- **Flag name:** None
- **Rollout sequence:** Not applicable
- **Kill switch owner:** Not applicable
- **Behavior when disabled:** Not applicable

The Skill Library menu item follows the existing Playbooks menu visibility. No new flag.

---

## Out of Scope

- Write profiles on agent steps.
- Creating reader identities for projects other than MaxView.
- A timeout branch on an interactive step.
- Slot placeholders in skill text.
- Custom output fields beyond the four kinds.
- Copying existing foundation skills into the version store.
- Letting a project edit or fork a foundation skill.
- A production inventory as a merge gate.
- AI-assisted editing, and promoting a project skill to a foundation skill.
- Reassigning an interactive step.
- Turning package skill copies into presets.
- The SkillOpt pilot (Part 4).
- Creating Azure DevOps work items from this backlog.

## Assumptions Made

- The accepted ADR "Playbooks Part 3: Skill Library and Skill Contracts" is the scope. This PRD does not add decisions.
- Playbooks menu visibility stays the way a project turns Playbooks on. The library does not need its own flag.
- MaxView already has a reader identity. Part 3 records it and does not create identities.
- Existing foundation skills stay files. Only the MaxView incident skill is copied into a project library. Published Playbooks that name any other current skill path keep today's file check.
- Each interactive turn runs as a Playbook agent run on the step's thread, not through the Agent Home chat path.
- A Playbook author sees skill names, types, and kinds in the builder without the skill-view permission.
