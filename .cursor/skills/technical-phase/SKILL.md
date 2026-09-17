---
name: technical-phase
description: Runs the Technical phase of a configurable two-phase interview as a build-focused conversation covering architecture, module boundaries, data and integration, quality/security/operability, rollout, and implementation sequencing, ending in a Technical Phase Summary. Use when an interview's Interview Flow includes a Technical phase, or when the user sends /technical-phase.
disable-model-invocation: true
---

# Technical Phase

## When to load this skill

Load when either is true:

- The interview being run has an Interview Flow that includes a Technical phase and the app has already routed this phase here.
- The user sends `/technical-phase`.

The app decides eligibility before this skill ever runs. Under the sequential flow the Technical phase is unlocked only once the Requirements phase summary is approved, and only the assigned Technical owner can run or write to it. Both checks live in the server and the UI — this skill does not re-implement them, but it also never works around them.

If the conversation you are handed shows that the Requirements phase is not yet approved, or that the person talking to you is not the assigned Technical owner, say so and stop. Do not start the question set.

This skill serves only the configurable phase flow. Interviews that do not opt into that flow keep using `/grill-with-docs` unchanged.

---

## Pre-read

Before the first technical question, read `.ai-pilot/kickoff-context.md`. The app seeds that file for this phase and it carries the two things you must not ask for again:

1. **The original prompt** — the request that started the interview, in the requester's own words.
2. **The approved Requirements Phase Summary** — the feature intent, users, scope, business rules, and success criteria the Requirements owner already approved.

Read both in full. In a remote-repo/MCP context, call `get_skill_file` with the exact path `.ai-pilot/kickoff-context.md`; do not search for it.

Then read `context.md` and `AGENTS.md` (repo root, same access rule) so the conversation names modules, services, and artifacts the way the codebase already names them.

Do not ask the first technical question until the original prompt and the approved Requirements summary have been read. Open instead by restating, in two or three lines, what the approved requirements commit the team to — then ask your first question against that.

Unlike the Requirements phase, reading source files is in bounds here. Open the services, routes, components, and migrations that the feature will touch whenever it sharpens a question or lets you propose a concrete option.

---

## Conversation style

- Ask one question per message using the **AskQuestion tool**. Wait for the answer, acknowledge it, then ask the next.
- Offer your recommended answer when the codebase already points to one, so the owner can confirm rather than compose. Name the file or pattern the recommendation comes from.
- Ground every question in something real: an approved requirement, an existing module, or a constraint you read in the repo. Do not ask hypotheticals the answers cannot act on.
- Push until an answer is specific enough for an implementer to act on without guessing. "We'll use a queue" is not an answer; which queue, which payload, and what happens on failure is.
- Keep the approved requirements as the fixed point. When an answer would change what the feature does rather than how it is built, treat it as a gap and follow the amendment path below.

---

## Question set

Work through these six areas in order. Each area may take several questions — keep going until the answers are specific enough to build from, then move to the next area.

**1. Architecture**

Where does this feature live in the running system, and what shape does it take? Ask which tier owns the behavior, whether work happens in the request path or asynchronously, and what the failure and retry story is. Get the decision and the alternative that was rejected, so the summary records a choice rather than a default.

**2. Module boundaries and design**

Which existing modules change, and what new ones appear? Ask where each new responsibility belongs, what each module owns exclusively, and which contracts cross the boundaries. Name the actual files and services. Push back when a responsibility is about to land in a module that already owns something unrelated.

**3. Data and integration**

What data does the feature read and write, what shape does it take, and who else already depends on it? Cover new or changed persistence, the migration and backfill story, and what happens to records that already exist. For every external or internal system the feature talks to, ask what it is asked for, what happens when it is slow or unavailable, and who owns the credential.

**4. Quality, security, and operability**

How will the team know this works, and know when it stops working? Ask what is covered by unit, integration, and end-to-end tests, and what deliberately is not. Ask who is allowed to perform the behavior and how that is enforced — permissions, ownership checks, tenancy. Ask what is logged, what is measured, and which signal tells an on-call engineer that this feature is the problem.

**5. Rollout**

How does this reach users? Ask whether it ships behind a feature flag and who the first cohort is, what order the deploy steps run in when there is a migration, and how the change is reversed if the first cohort hits trouble. Get the rollback story explicitly — "revert the deploy" is only an answer if the data changes allow it.

**6. Implementation sequencing**

What order does the work get built in? Ask for the slices an implementer can land one at a time, which slice unblocks the others, and where the risky or unknown work sits. Surface the dependencies that must be in place before slice one starts. The answer should read as a sequence a person could pick up on Monday.

---

## Amending the approved Requirements summary

Technical questions surface gaps in the approved requirements: a rule that contradicts itself, a behavior nobody scoped, a case the summary does not answer. When that happens, say what the gap is and what you believe the requirement should say. Do not silently design around it, and do not change the requirement on your own initiative.

If the owner asks you to close the gap, write the amendment to:

```
.ai-pilot/output/requirements-amendment.md
```

The file content must be the **complete** amended Requirements summary — the full replacement text, every section included, ready to stand on its own as the approved requirements. It is not a patch, not a diff, and not a list of edits. Carry every unchanged section through verbatim and fold the new decision into the section that owns it.

Keep the section structure the approved Requirements summary already uses, in this order, so the amendment is a like-for-like replacement: the `Requirements Phase Summary — {Feature name}` title, then feature intent, users and stakeholders, in scope, out of scope, business rules and constraints, success criteria, and unresolved requirements questions.

Write the file once, then confirm in chat: name the gap, name the section you changed, and say the amended summary has been handed to Apex for the Requirements owner to see. The app reads this file after every completed turn and is what actually updates the stored summary and notifies the Requirements owner — so a turn that writes the file is a turn that applies the amendment, and writing it twice with the same content applies it twice.

Then continue the Technical conversation from the question you were on. An amendment is not the end of the phase and does not send the interview back to Requirements.

---

## Resuming an unfinished phase

A Technical phase is often ended before its natural conclusion and picked up later. On every turn, before choosing the next question:

1. Read the existing conversation transcript for this phase.
2. Mark which of the six areas already have answers, and skip those areas entirely.
3. Ask the next unanswered question, restating the last decision in one line so the owner is oriented.

Do not restart the question sequence, do not re-ask an area that is already answered, and do not re-issue the opening restatement of the requirements on resume. If the transcript shows all six areas answered, move to the summary.

---

## Technical Phase Summary

When the conversation reaches its natural end — all six areas answered, or the user says "done", "that's enough", or "wrap up" — write the summary to:

```
.ai-pilot/output/{interview-slug}.technical-phase-summary.md
```

Use the interview's own slug for `{interview-slug}`. Write the file once, then tell the user in chat that the summary is ready for review. The app reads this path after every completed turn, so the file is the hand-off — a summary described only in chat does not reach the reviewer.

Use this template:

```markdown
# Technical Phase Summary — {Feature name}

## Architecture decisions
- {Decision} — why, and the alternative that was rejected.

## Module boundaries and design
- {Module or file} — what it owns after this change, and the contract it exposes.

## Data and integration
- {Data or system} — shape, ownership, migration and backfill, and behavior when a dependency fails.

## Quality, security, and operability
- {Test level, permission rule, log, or metric} — what it covers and what it deliberately does not.

## Rollout
- {Flag, deploy order, cohort, or rollback step} — the condition and the action.

## Implementation sequence
1. {Slice} — what it delivers and what it unblocks.

## Unresolved technical questions
- {Open question} — who needs to answer it.
```

Every section is required. When an area produced nothing, say so in one line ("No external integrations are involved") rather than dropping the heading — a reviewer needs to see the gap.

---

## What this skill does NOT do

- Does not generate a PRD. PRD generation is triggered separately, after the phases are approved.
- Does not reopen, reset, or re-run the Requirements phase. The only way this skill changes approved requirements is the amendment file above.
- Does not write to the database, to Azure Blob Storage, or to any other storage the app owns. Everything this skill produces is a file in `.ai-pilot/output/` that the app's phase lifecycle reads and applies.
- Does not approve its own summary, unlock a phase, reassign an owner, or notify anyone — the app does all of that from the files this skill writes.
- Does not modify, replace, or retire `/grill-with-docs` or `/requirements-phase`, which continue to serve their own interviews.
- Does not write production code. It decides how the feature will be built and records that decision.
