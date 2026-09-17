---
name: requirements-phase
description: Runs the Requirements phase of a configurable two-phase interview as a feature-focused, non-technical conversation covering feature intent, target users, in-scope behavior, success criteria, and explicit non-goals, ending in a Requirements Phase Summary. Use when an interview's Interview Flow includes a Requirements phase, or when the user sends /requirements-phase.
disable-model-invocation: true
---

# Requirements Phase

## When to load this skill

Load when either is true:

- The interview being run has an Interview Flow that includes a Requirements phase (the phase routes here instead of `/grill-with-docs`).
- The user sends `/requirements-phase`.

This skill serves only the configurable phase flow. Interviews that do not opt into that flow keep using `/grill-with-docs` unchanged.

---

## Pre-read

1. Read `context.md` (repo root) — the product context guide. In a remote-repo/MCP context, call `get_skill_file` with this exact path; do not search for it. Know the product terminology and workflows so the conversation uses the team's canonical words. This is the only mandatory pre-read.
2. Read `AGENTS.md` (repo root) — in a remote-repo/MCP context, call `get_skill_file` with this exact path. Use its terminology table to name features and artifacts the way the product already names them.

Do not ask the first question until step 1 is complete.

Stop there. Do not open source files, design docs, or anything else to form a technical picture of how the feature would be built. Reading code to sharpen a feature-level question is out of bounds in this phase — the Technical phase owns that ground.

---

## Conversation style

- Stay in the language of the person you are interviewing: what the feature is for, who needs it, and how they will know it worked.
- Ask one question per message using the **AskQuestion tool**. Wait for the answer, acknowledge it, then ask the next.
- Offer your recommended answer when one option is clearly better, so the reviewer can confirm rather than compose.
- Sharpen fuzzy wording as it appears: when a term is vague or overloaded, propose the precise product term from `context.md` and ask the user to confirm.
- Never ask a question whose phrasing already assumes how the feature will be built.

---

## Question set

Work through these five areas in order. Each area may take several questions — keep going until the answers are specific enough for a reviewer to act on, then move to the next area.

**1. Feature intent**

What problem does this feature solve, and what changes for the business once it exists? Push for the outcome, not the mechanism: "what can someone do afterwards that they cannot do today?"

**2. Target users and personas**

Who performs this work today, and who will perform it once the feature ships? Name the personas and the groups they belong to. Ask who else sees the result without doing the work — reviewers, approvers, and people who only need to be told.

**3. In-scope behavior**

Walk the feature as a story from the user's side: what they start with, what they do, what they get back. Stress-test the boundaries with concrete situations — what happens when the information is incomplete, when two people act at once, when the work is abandoned halfway. Capture every rule and constraint the answers reveal.

**4. Success criteria**

How will the team know this feature worked? Ask for the observable signal — the behavior someone can check, the decision that becomes easier, the count that should move. Do not accept "it works"; get to what "worked" looks like from the outside.

**5. Explicit non-goals**

What is deliberately not included, and what should the feature refuse to do? Name adjacent things a reader might reasonably assume are included so they can be ruled out on the record.

---

## Redirecting implementation detail

Answers will sometimes arrive as implementation detail — a named library, a storage choice, a screen layout, a queue. Do not pursue it and do not build a follow-up question around it. Acknowledge it so the user knows it was heard, note it for the Technical phase, then return to feature intent with this wording:

> That's an implementation choice — the Technical phase will cover it. Sticking to what the feature needs to do: …

Complete the sentence with the feature-level question you were about to ask.

The same applies when the user uses a technical term you cannot map to anything feature-level: ask what the user would be able to do if that term were satisfied, and record the answer instead of the term.

---

## Resuming an unfinished phase

A Requirements phase is often ended before its natural conclusion and picked up later. On every turn, before choosing the next question:

1. Read the existing conversation transcript for this phase.
2. Mark which of the five areas already have answers, and skip those areas entirely.
3. Ask the next unanswered question, restating the last decision in one line so the user is oriented.

Do not restart the question sequence, do not re-ask an area that is already answered, and do not re-issue the opening question on resume. If the transcript shows all five areas answered, move to the summary.

---

## Requirements Phase Summary

When the conversation reaches its natural end — all five areas answered, or the user says "done", "that's enough", or "wrap up" — write the summary to:

```
.ai-pilot/output/{interview-slug}.requirements-phase-summary.md
```

Use the interview's own slug for `{interview-slug}`. Write the file once, then tell the user in chat that the summary is ready for review.

Use this template:

```markdown
# Requirements Phase Summary — {Feature name}

## Feature intent
One paragraph on the problem and the outcome, in business language.

## Users and stakeholders
- {Persona or group} — what they do with the feature.

## In scope
- {Behavior} — stated as what the user can do.

## Out of scope
- {Non-goal} — and, where it helps, the phase or feature that owns it instead.

## Business rules and constraints
- {Rule} — the condition and what must hold.

## Success criteria
- {Observable signal that the feature worked}

## Unresolved requirements questions
- {Open question} — who needs to answer it.
```

Every section is required. When an area produced nothing, say so in one line ("No non-goals were named") rather than dropping the heading — a reviewer needs to see the gap.

---

## What this skill does NOT do

- Does not generate a PRD. PRD generation is triggered separately, after the phases are approved.
- Does not ask architecture, data, sequencing, or other build-shaped questions — those belong to the Technical phase.
- Does not read or reason about source code to answer its own questions.
- Does not modify, replace, or retire `/grill-with-docs`, which continues to serve interviews outside this flow.
- Does not write production code, and does not write files other than its own phase summary.
