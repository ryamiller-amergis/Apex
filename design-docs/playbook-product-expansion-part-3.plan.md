---
name: Playbook Product Expansion — Part 3
overview: SkillOpt pilot deferred from Part 2. A person reviews one proposed skill revision. The pilot does not run inside a Playbook and does not publish a skill by itself.
status: proposed
part: 3
requires: design-docs/playbook-product-expansion-part-2.plan.md
scope:
  - One offline SkillOpt pilot against a chosen skill and its approved transcripts
  - A reviewed skill-file diff, committed only by a person
out_of_scope:
  - Changing Playbook graphs or registering step types
  - Auto-publishing a skill into the repository
  - A product page, until a pilot has already produced one reviewed revision
---

# Playbook Product Expansion — Part 3: SkillOpt

Part 2 is `design-docs/playbook-product-expansion-part-2.plan.md`. This pilot was removed from
that plan. Do not start it until Part 2's recommender is in use and a person has recorded which
run transcripts may be sent to the optimizer.

## Decision

SkillOpt (Microsoft Research, 2026) treats a skill markdown file as trainable state for a frozen
model. Edits are small, and an edit is kept only when a held-out score improves. The deployed
artifact is still a `SKILL.md`, with no extra model call at runtime.

The pilot uses completed Playbook runs that already have scorecards. It proposes a skill revision
for a person to review. It does not change graphs, register nodes, or publish a skill unattended.

The pilot waits until legal and security agree that the chosen run transcripts may be sent to the
optimizer model.

## Pilot

Offline only. Inputs are a chosen Skill path, a set of completed runs of Playbooks that use that
Skill, and the scorecards Part 1 already stored. The optimizer proposes a revised skill document.
A reviewer diffs it and decides whether to commit it.

The first candidate is `design-doc-validation`, because it already produces a scorecard. That
choice, and whether its transcripts are approved, is still open. Do not infer it.

The pilot does not run inside a Playbook step. No product flag is required until a UI exists.
The first run can be a documented offline pass rather than a page.

## Acceptance

1. The optimizer proposes one skill file a person reviews.
2. Nothing in the repository changes until that person commits the revision.
3. Input is limited to the approved transcript set.

## Open decision

Is `design-doc-validation` the pilot skill, and are its transcripts approved for the optimizer?
