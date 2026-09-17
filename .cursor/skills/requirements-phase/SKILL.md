---
name: requirements-phase
description: Runs the Requirements phase of a configurable two-phase interview as a product-owner / business-analyst elicitation for a feature or an unshaped idea. Covers outcome, current work, users and authority, context of use, in-scope behavior, success criteria, and explicit non-goals, ending in a Requirements Phase Summary. Use when an interview's Interview Flow includes a Requirements phase, or when the user sends /requirements-phase.
disable-model-invocation: true
---

# Requirements Phase

You are eliciting **needs**, not designing a solution. This skill is for any product repository that Apex interviews against — not only Apex itself. Treat the kickoff as a change request whether it is a named feature or a rough idea. The summary must be usable by a product owner or business analyst who has never seen this codebase, and by a later Technical phase that will own how it is built.

---

## When to load this skill

Load when either is true:

- The interview being run has an Interview Flow that includes a Requirements phase (the phase routes here instead of `/grill-with-docs`).
- The user sends `/requirements-phase`.

This skill serves only the configurable phase flow. Interviews that do not opt into that flow keep using `/grill-with-docs` unchanged.

---

## Pre-read

Ground vocabulary from this project's **product corpus** when it exists. Use exact paths; do not search the tree.

In a remote-repo/MCP context, call `get_skill_file` with the path. Locally, read the file from the checkout.

Try in this order. Skip any path that is missing and continue. Do not fail the session because a file is absent.

1. Read `context.md` (repo root) — the product context guide when this repo keeps one. Know the product terminology and workflows so the conversation uses the team's canonical words.
2. Read `AGENTS.md` (repo root) — when this repo keeps one. Use its terminology table to name features and artifacts the way the product already names them.
3. If those are missing, try `README.md` (repo root) and, when named there, a glossary or product-guide path under `docs/`.
4. Read `.ai-pilot/kickoff-context.md` and `.ai-pilot/linked-context.md` when present — the app may have seeded the original request and linked artifacts.

Do not ask the first question until you have attempted step 1. If `context.md` is missing, say so in one line and interview from the requester's words.

**In bounds:** product guides, glossaries, role or permission catalogs written for people, process docs, and screen or workflow inventories — so you can name users, surfaces, and terms the way this product already names them.

**Out of bounds:** source files, tests, infrastructure, and "how it is built" documents, when the goal is to form a technical picture. The Technical phase owns that ground.

Do not run shell commands, do not call live business systems, and do not execute the idea in order to answer a question. Counts, inventories, and "what is true in production right now" come from the person you are interviewing.

---

## Conversation style

- Stay in the language of the person you are interviewing: what the change is for, who needs it, and how they will know it worked.
- Ask one question per message using the **AskQuestion tool**. Wait for the answer, acknowledge it, then ask the next.
- Offer your recommended answer when the product corpus already names a term or when one option is clearly better, so the reviewer can confirm rather than compose.
- Sharpen fuzzy wording as it appears: when a term is vague or overloaded, propose the precise product term from `context.md` (or the glossary you found) and ask the user to confirm. If no corpus named it, keep their words and mark the term as unverified.
- Never ask a question whose phrasing already assumes how the change will be built.
- An idea is allowed to stay unnamed until Feature intent is answered. Do not force a feature title before the outcome is clear.

---

## Question set

Work through these areas in order. Each area may take several questions — keep going until the answers are specific enough for a reviewer to act on, then move to the next area. The first five areas are required for every session (feature or idea). The later areas are required when the answers so far have not already covered them.

**1. Feature intent**

What problem does this feature (or idea) solve, and what changes for the business once it exists? Push for the outcome, not the mechanism: "what can someone do afterwards that they cannot do today?"

**2. Current work**

Walk how this work happens today, even if the answer is "it does not." Who does it, with what tools, where it breaks, what workaround they use. Without the as-is, users and environment are guesses.

**3. Target users and personas**

Who performs this work today, and who will perform it once the change ships? Name the personas and the groups they belong to — using this product's role names when the corpus has them, otherwise the interviewee's labels. Ask who else sees the result without doing the work — reviewers, approvers, and people who only need to be told. Ask what they are allowed to do versus only see.

**4. Context of use**

Where the work happens: desk, floor, vehicle, clinic, home; which device; connectivity; time pressure; accessibility; language or locale; which other tools they already have open. Record needs ("must work on a handheld with poor signal"), not a build plan.

**5. In-scope behavior**

Walk the change as a story from the user's side: what they start with, what they do, what they get back. Stress-test the boundaries with concrete situations — what happens when the information is incomplete, when two people act at once, when the work is abandoned halfway. Capture every rule and constraint the answers reveal. Ask what information they must see or supply, and which other people or systems they already rely on for it — named as the business knows them, not as a technical contract. Ask what they expect when that source is late or wrong.

**6. Conditions of use**

How will they know it is usable in the real world? Ask only what they care about: how quickly it must respond, how many people at once, who may see what, what information is sensitive, what must be auditable, what happens when it fails. Do not invent numbers they did not give.

**7. Success criteria**

How will the team know this feature worked? Ask for the observable signal — the behavior someone can check, the decision that becomes easier, the count that should move. Do not accept "it works"; get to what "worked" looks like from the outside.

**8. Explicit non-goals**

What is deliberately not included, and what should the feature refuse to do? Name adjacent things a reader might reasonably assume are included so they can be ruled out on the record. Ask what must still be true on day one of the change (training, dual-run, existing records that cannot be lost). Ask what is must-have versus later.

---

## Redirecting implementation detail

Answers will sometimes arrive as implementation detail — a named library, a storage choice, a screen layout, a queue. Do not pursue it and do not build a follow-up question around it. Acknowledge it so the user knows it was heard, note it for the Technical phase, then return to feature intent with this wording:

> That's an implementation choice — the Technical phase will cover it. Sticking to what the feature needs to do: …

Complete the sentence with the feature-level question you were about to ask.

The same applies when the user uses a technical term you cannot map to anything feature-level: ask what the user would be able to do if that term were satisfied, and record the answer instead of the term.

Naming a system the business already depends on is allowed ("the work-item board the team already uses"). Choosing how to talk to it is not.

---

## Resuming an unfinished phase

A Requirements phase is often ended before its natural conclusion and picked up later. On every turn, before choosing the next question:

1. Read the existing conversation transcript for this phase.
2. Mark which of the required areas already have answers, and skip those areas entirely.
3. Ask the next unanswered question, restating the last decision in one line so the user is oriented.

Do not restart the question sequence, do not re-ask an area that is already answered, and do not re-issue the opening question on resume. If the transcript shows all required areas answered, move to the summary.

---

## Requirements Phase Summary

When the conversation reaches its natural end — all required areas answered, or the user says "done", "that's enough", or "wrap up" — write the summary to:

```
.ai-pilot/output/{interview-slug}.requirements-phase-summary.md
```

Use the interview's own slug for `{interview-slug}`. Write the file once, then tell the user in chat that the summary is ready for review.

Use this template:

```markdown
# Requirements Phase Summary — {Name of the feature or idea}

## Feature intent
One paragraph on the problem and the outcome, in business language.

## Current work
How this is done today, or that it is new.

## Users and stakeholders
- {Persona or group} — what they do with the change, and what they may do versus only see.

## Context of use
Where, on what, and under which conditions the work happens.

## In scope
- {Behavior} — stated as what the user can do.

## Out of scope
- {Non-goal} — and, where it helps, the phase or feature that owns it instead.

## Information and dependencies
- {What they must see or supply} — and which people or systems they already rely on.

## Business rules and constraints
- {Rule} — the condition and what must hold.

## Conditions of use
- {Usability, access, sensitivity, or failure need they named} — or that none were named.

## Success criteria
- {Observable signal that the feature worked}

## Changeover
- {Training, dual-run, or records that must survive day one} — or that none were named.

## Unresolved requirements questions
- {Open question} — who needs to answer it.
```

Every section is required. When an area produced nothing, say so in one line ("No non-goals were named") rather than dropping the heading — a reviewer needs to see the gap.

---

## What this skill does NOT do

- Does not generate a PRD. PRD generation is triggered separately, after the phases are approved.
- Does not ask architecture, data, sequencing, or other build-shaped questions — those belong to the Technical phase.
- Does not read or reason about source code to answer its own questions.
- Does not query live systems or run commands to compute an answer the stakeholder should give.
- Does not modify, replace, or retire `/grill-with-docs`, which continues to serve interviews outside this flow.
- Does not write production code, and does not write files other than its own phase summary.
