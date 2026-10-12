---
name: grill-with-docs
description: Structured requirements interview that confirms product needs, delivery rules, and optional technical decisions before PRD generation.
---

# Grill With Docs — Foundation

Conduct a structured requirements interview before PRD generation. Discovery
and Delivery use product language for a Business Analyst or Product Owner.
Technical is optional and comes last.

## Grounding

If `.ai-pilot/linked-context.md` is present, read it and treat its
provenance-labeled sections as authoritative project grounding. Load the
project adapter and its identified context guide. Do not search the repository
during Discovery or Delivery when the host has already supplied a product
brief. Repository detail belongs in Technical.

## Interview method

Ask one question per response, then stop. Use a broad-to-narrow pattern:

- Start each topic with an open, neutral question about a real situation or
  observable outcome.
- Do not lead with a proposed solution or several detailed answer packages.
- Use choices only to confirm or narrow a decision already supported by the
  conversation or project context.
- If choices are needed, each decides one thing, remains mutually exclusive,
  and is one short sentence.
- End each numbered topic with `Skip — decide later`. Record a skip as
  unresolved and do not ask it again.
- Ask at most one follow-up when an answer is unclear, conflicts with an
  earlier decision, or needs one concrete example.
- Quote conflicting decisions without judgment and ask which is authoritative.
- Keep stated facts, inferences, assumptions, and unresolved items distinct.

Use these phase markers on the first line:

```text
[[interview-phase:discovery:N:6]]
[[interview-phase:discovery:N:6:followup]]
[[interview-phase:delivery:N:5]]
[[interview-phase:delivery:N:5:followup]]
[[interview-phase:delivery:done]]
[[interview-phase:technical:N:5]]
[[interview-phase:technical:wrapup]]
[[interview-phase:technical:done]]
[[interview-phase:technical:skipped]]
```

## Phase 1 — Discovery

Always run these six topics in order:

1. **Current situation, problem, and impact** — ask for a recent concrete
   example: what triggers it, what happens today, what goes wrong, and who
   feels the impact. Start from the problem, not the proposed feature.
2. **Observable success criteria** — define success early. Ask what user or
   business outcome would prove the change worked. Seek a measurable signal
   when practical, but do not invent one.
3. **Users and business rules** — identify the people involved and the rules
   governing their actions. Ask only for the most important missing actor or
   rule.
4. **Release-one scope and boundaries** — summarize likely in-scope and
   out-of-scope work, then ask for confirmation or correction.
5. **Concrete scenarios and exceptions** — test one agreed rule with a
   main-path or exception example. Do not introduce unrelated edge cases.
6. **Discovery brief confirmation** — synthesize the problem, users,
   observable success criteria, business rules, scope, examples, assumptions,
   and unresolved items. Ask the person to confirm or correct it.

## Phase 2 — Delivery

Carry the confirmed Discovery brief forward. Do not elicit the same information
again. Cover these five topics:

1. **Actor and action confirmation** — summarize actor-to-action rules and ask
   only for corrections or one missing action.
2. **Failure and recovery behavior** — ask what the person sees and can do when
   the main action cannot finish.
3. **Information visibility and sensitivity** — summarize known visibility,
   then ask what must be hidden or limited and from whom.
4. **Release-one dependencies and deferred scope** — summarize the release
   slice and ask about one unresolved business dependency or boundary that
   could prevent it from meeting the success criteria.
5. **Delivery brief confirmation** — synthesize actor/action rules, failure and
   recovery, visibility, dependencies, deferred scope, acceptance outcomes,
   and unresolved items. Ask the person to confirm or correct it.

Do not ask which artifacts to generate. The host project configuration decides
whether to produce a prototype, test cases, and a design document.

After confirmation, ask only:

```text
a. Continue to technical decisions
b. Generate the PRD
```

## Phase 3 — Technical

Run only when the person chooses it. Ask these five topics in order, with at
most one follow-up each:

1. Surface — frontend, backend, or both
2. Existing pattern to follow, extend, or replace
3. Data model and existing storage to extend
4. Performance bounds for the main action
5. Rollout and feature-flag behavior

After topic 5, recap decisions and list unasked edge cases under **Left for the
design doc**. Ask whether to finish or go deeper. Going deeper allows at most
three more high-impact questions and no follow-ups. Do not spend those questions
on low-level state combinations.

## Transcript

When the interview finishes, write `.ai-pilot/kickoff-transcript.md` with:

- Feature description
- Discovery brief
- Delivery brief
- Technical decisions, or unresolved when Technical was skipped
- Stated facts, assumptions, unresolved questions, and deferred scope
- Business rules and concrete examples
- Observable success criteria and acceptance outcomes

Tell the person the transcript is ready for PRD generation.
