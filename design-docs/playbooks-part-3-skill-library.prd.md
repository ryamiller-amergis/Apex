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

A Playbook skill is a file in the Apex repo. A project cannot own one, and editing a shared skill changes the bytes a published Playbook was pinned to, so the next run fails. A person can talk to an interview step, but an ordinary agent task always runs in the background. Projects that share a procedure, such as incident investigation, cannot keep their own resource data without copying the whole skill.

## Solution

Each project gets a Skill Library of versioned skills. Universal presets stay shared and immutable. A project adds its own companion files and may fork a preset. Instruction files stay pinned to the published Playbook. Reference files, such as a resource catalog, are read at their latest approved version when a run starts. An agent task whose skill is interactive opens a chat in the run view, and the run continues only after the assignee approves a valid result.

## Implementation Decisions

- A skill version store (deep module) saves presets, forks, project skills, and companion files as versions that never change. A draft is a separate record. The store is the source a publish and a run read.
- A preset is identified by its frontmatter name, not its path. A rename map links an old name to the current one, so a renamed preset continues as a later version of the same preset.
- Publish freezes a skill version and a bundle hash that covers the skill text and the instruction files. Reference files are not in that hash. Policies already published keep today's single-file hash.
- The run worker checks the hash it is given. It does not decide which file is reference data. The application resolves reference files once per run and records the version it used.
- One startup pass inserts a new preset version when a preset source file has a new hash. It never edits an existing version or a published Playbook. A draft shows that a newer preset exists until someone accepts it.
- Frontmatter is parsed as YAML. Skill type and output kind live under metadata. The existing capability list stays where published files already have it. Type and kind are copied to columns so the picker can filter. The file bytes remain the source of truth.
- Output kinds are a fixed set. Each kind's result includes the fields an agent task already returns, plus the kind's own fields. Publish rejects a binding to a field the kind does not return.
- The interactive step is a new registered step type. Each turn is an agent run on that step's thread and is checked against the policy frozen at publish. The chat is shown in the run's suspension panel.
- A project setting stores the reader identity used by skills that need a read-only cloud shell. The run specification carries that identity. The worker has no fallback identity.
- The current incident skill is renamed to a project-neutral preset. Its MaxView resource catalog becomes MaxView's first approved reference file. Published Playbooks keep running against the imported original bytes.
- New permissions cover viewing skills, authoring them, and approving reference files. The existing author permission is reused. Capability and skill-type changes on a fork are approved by a Platform Admin.

## Testing Decisions

- **What makes a good test here:** A published Playbook still runs when the skill file on disk changes, and it runs the bytes it pinned. A reference-file approval changes the next run without a republish. An interactive step does not resume on output that fails its kind.
- **Modules to test:**
  - Skill version store — versions are immutable and a draft does not change a published pin.
  - Publish and run policy — the bundle hash matches for instruction files and ignores reference files.
  - Startup import and migration — an old pin resolves to the imported version, including a renamed preset.
  - Interactive step — a proposal is hidden until it is valid, and a cancelled run leaves no result.
  - Library permissions — reference-file contents are hidden from view-only users, and an author cannot approve their own version.
- **Prior art:** Playbook publish guards and the existing agent-run policy checks. Interview suspension, deadline, and cancel behavior. Permission checks on project-scoped admin pages.

## Target Surface

- **Primary surface:** Full-stack (both client and server)
- **Experience notes:** The Skill Library is a project page shown only where Playbooks are enabled. The interactive chat appears inside the run the person already has open. The builder's skill picker shows names, types, and kinds to a Playbook author.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| See skill names, types, and kinds in the Playbook builder | Playbook author | Project-scoped |
| Open the Skill Library and read instruction files | Skill viewer | Project-scoped |
| Create a skill, fork a preset, edit drafts | Skill author (existing manage permission) | Project-scoped |
| Read or approve reference-file contents | Skill author, or reference approver | Project-scoped |
| Approve a fork's capability or skill-type change | Platform Admin | Global |

---

## Security and Data Sensitivity

- **Sensitive fields:** Reference files may hold subscription and workspace identifiers. They must not hold secrets. Reader identity client IDs are configuration, not skill text.
- **Handling requirements:** Reference-file contents are excluded from view-only library responses. Run output is not filtered. Approving a reference file is recorded with the approver, and the author of that version cannot be the approver.
- **Data scope enforcement:** Skills, forks, and companion files belong to one project. A preset is readable by every project that can use Playbooks. A run reads another project's reference file only when that file is pinned for its own project.

---

## Non-Functional Requirements

- **Response time:** Saving a skill draft and opening the library complete within 2 seconds at P95. Generating a draft may take longer and shows progress.
- **Concurrency:** One instance at a time performs the startup import. Two approvers cannot approve the same draft version.
- **Data volume:** A skill file or companion file over 200,000 bytes is rejected on save or approval. A preset source over that limit is skipped and logged.

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
- AI-assisted forks, and promoting a project skill to a preset.
- Reassigning an interactive step.
- Turning package skill copies into presets.
- The SkillOpt pilot (Part 4).
- Creating Azure DevOps work items from this backlog.

## Assumptions Made

- The accepted ADR "Playbooks Part 3: Skill Library and Skill Contracts" is the scope. This PRD does not add decisions.
- Playbooks menu visibility stays the way a project turns Playbooks on. The library does not need its own flag.
- MaxView already has a reader identity. Part 3 records it and does not create identities.
- The production inventory is a gate for the migration, and its results are not known yet. The allow-list of preset paths outside the foundation folder grows from that inventory.
- Each interactive turn runs as a Playbook agent run on the step's thread, not through the Agent Home chat path.
- A Playbook author sees skill names, types, and kinds in the builder without the skill-view permission.
