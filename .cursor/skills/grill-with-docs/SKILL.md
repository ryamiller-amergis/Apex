---
name: grill-with-docs
description: Three-phase feature interview. Discovery and Delivery come first in product language. Technical depth is optional and comes last. Use when starting a feature interview or when the user sends /grill-with-docs.
---

# Grill With Docs

This interview uses the Guided Interview plan until a project phase plan says otherwise. Discovery and Delivery are required. Technical is optional. A Business Analyst can generate a PRD once those two phases are done. Do not edit this skill during the interview.

## When to load this skill

Load immediately when any of the following are true:

- The user sends `/grill-with-docs`.
- The user asks to start a feature interview, grill a plan, or pressure-test a feature before a PRD.
- The user wants to resolve what the canonical term for a concept is.

## How to invoke

```
/grill-with-docs
```

No arguments. The session runs against the plan, design, or idea already in the chat. If nothing is stated, the first Discovery question asks what problem they want to solve.

## Before the first question

If `.ai-pilot/linked-context.md` is present, read it and treat it as extra project grounding. If it is absent, continue.

Apex puts an application brief in the message before each Discovery and Delivery turn. That brief is the product context. It is already loaded. Do not open `context.md`, and do not search for it.

Repository tools are closed during Discovery and Delivery. Do not call grep, glob, read, `search_repo_code`, `get_skill_file`, or `list_repo_dir`. If the brief does not answer something, ask the person or record it as unresolved.

`AGENTS.md`, design docs, and source files belong in Technical, and only when that phase starts.

## How to ask

Ask one question per message, then stop and wait.

This chat has no AskQuestion tool. End the message with options in this shape, each on its own line:

```
a. First choice
b. Second choice
c. Skip — decide later
```

The last option on every phase question is `Skip — decide later`. A skip is recorded as unresolved. Do not ask that question again.

When an answer is already obvious from the conversation or from the application brief, state the recommendation in one or two sentences, then ask the person to confirm it or change it. Do not ask an open question when a recommendation will do.

The person may also type their own answer instead of picking an option. Acknowledge it and move on.

If they say they are done, or that they want a PRD, before the current phase is finished: stop asking, mark every remaining topic as unresolved, write the transcript, and tell them they can generate the PRD from this interview. Start that closing message with `[[interview-phase:discovery:stopped]]` or `[[interview-phase:delivery:stopped]]`, matching the phase that was still open.

The interview screen shows Discovery, Delivery, and Technical. It reads a marker and does not show that marker to the person. Put the marker on the first line of every reply, and do not mention it. Do not write the marker into `.ai-pilot/kickoff-transcript.md`.

| Moment | First line |
|---|---|
| Discovery topic 2 of 6 | `[[interview-phase:discovery:2:6]]` |
| The one follow-up on Discovery topic 2 | `[[interview-phase:discovery:2:6:followup]]` |
| Delivery topic 1 of 5 | `[[interview-phase:delivery:1:5]]` |
| The one follow-up on Delivery topic 1 | `[[interview-phase:delivery:1:5:followup]]` |
| Delivery is done and they may continue or generate a PRD | `[[interview-phase:delivery:done]]` |
| Technical topic 3 of 5 | `[[interview-phase:technical:3:5]]` |
| Technical topics done; finish or go deeper | `[[interview-phase:technical:wrapup]]` |
| Deeper Technical question 6 of 8 | `[[interview-phase:technical:6:8]]` |
| They generate a PRD without Technical | `[[interview-phase:technical:skipped]]` |
| Technical is finished | `[[interview-phase:technical:done]]` |

After each phase, give a short recap of what was decided and what was skipped. Keep the recap in the same message as the next step. The message still ends with one question. The marker on that message names the step you are now asking, not the phase you just finished.

## Phase 1 — Discovery

Always run this phase. Six topics, in this order, and no extras. Ask one question per topic. If the answer is unclear, contradictory, or reveals an important exception, ask one follow-up on that same topic, then move on. If the answer is already sufficient, do not ask a follow-up. A skipped topic stays unresolved. The screen shows Topic N of 6, not a question count.

1. Problem and who has it
2. What success looks like
3. Who uses it, and what they can do
4. What is in scope, and what is out
5. The main scenarios, including the obvious exceptions
6. Acceptance criteria in plain language

Discovery is complete when each topic has an answer or a skip.

Then recap and go straight into Delivery. Delivery is part of this interview. Do not treat it as optional, and do not offer to stop for a PRD until Delivery is complete.

## Phase 2 — Delivery

Five topics, in this order, and no extras. Ask one question per topic, plus at most one follow-up when the answer is unclear, contradictory, or reveals an important exception. Do not ask a follow-up when the answer is already sufficient. A skipped topic stays unresolved. The screen shows Topic N of 5. Write for a Business Analyst or Product Owner. Describe what a person can see and do, and what belongs in the first release versus a later one. Do not mention persistence, CRUD, databases, APIs, schemas, MCP, skills, agent context, routes, components, or permission keys. Name groups the way a BA would: BA, Developer, QA, Manager, Product Owner, and so on.

1. Who can do each action
2. What the user sees when they are not allowed
3. Whether any information is sensitive, and what must be hidden
4. What "done" means for the first release versus a later one
5. Which follow-on outputs this work needs: prototype, test cases, design doc

When all five have an answer or a skip, recap, then ask this and nothing else. The first line of that message is `[[interview-phase:delivery:done]]`.

```
a. Continue to technical decisions
b. Generate the PRD
```

There is no skip on this question. If they choose the PRD, write the transcript with Technical left as unresolved assumptions. The reply starts with `[[interview-phase:technical:skipped]]`. Tell them to use Generate PRD on this interview. Do not start Technical.

## Phase 3 — Technical

Run this phase only after they choose to continue. It covers the few technical choices the design doc needs from a person: frontend or backend, existing patterns, data model, performance, and rollout. It is not required for a PRD, and it has an end.

Read `AGENTS.md` with `get_skill_file` first. Open one more design doc or source file only when the current question needs it. That is the limit: two reads. Do not use grep, glob, or `search_repo_code`. If a gap remains, record an unresolved assumption and ask the person.

Five topics, in this order. Ask one question per topic, plus at most one follow-up when the answer is unclear, contradictory, or reveals an important exception. Recommend from the codebase when you can. Each one still ends with `Skip — decide later`. The screen shows Topic N of 5.

1. Surface — frontend, backend, or both
2. Existing pattern to follow, extend, or replace
3. Data model — what is stored, and whether it extends something that already exists
4. Performance bounds for the main action — response time, concurrent users, and data volume
5. Rollout — ship directly, or behind a feature flag, and what the user sees when it is off

Do not ask about edge-case state rules here: a second click while a run is in progress, reassignment mid-run, approval withdrawn after completion, history of failed attempts, and the like. The design doc stage decides those against the real code. Note them as you go.

After topic 5, recap the Technical decisions, list the edge cases you noticed under **Left for the design doc**, and ask only this. The first line is `[[interview-phase:technical:wrapup]]`.

```
a. Finish Technical
b. Go deeper (up to 3 more questions)
```

If they go deeper, ask up to three more questions, numbered `[[interview-phase:technical:6:8]]` through `[[interview-phase:technical:8:8]]`, with no follow-ups. Pick decisions that change how the feature is built, not edge cases. Then finish.

Use these lenses for any question, and do not reopen Discovery or Delivery topics that already have an answer:

- If a term conflicts with `context.md`, say so and ask which meaning they intend.
- Replace a fuzzy word with the Apex term and ask them to confirm.
- If they assert how the code works, check the known file before agreeing.
- State the better option and ask them to confirm or change it.

Unfinished Technical questions do not block the PRD. They go in the transcript as unresolved assumptions, and the edge cases go there as "decide in design doc". When Technical is finished, the closing message starts with `[[interview-phase:technical:done]]`.

## Terms

When a term is resolved and you can write files, update `context.md` in the same turn, then ask the next question. Do not batch these. Use:

```markdown
### {Term}

- **Definition:** One sentence a domain expert would recognize.
- **Use when:** The situation this term applies to.
- **Don't confuse with:** The sibling term, and how it differs.
```

`context.md` stays free of implementation detail. If you cannot write files, prefix the resolution with `📌 CONTEXT update:` in the chat so the transcript keeps it.

## Transcript

When the interview stops, write `.ai-pilot/kickoff-transcript.md` with these sections:

- **Feature Description**
- **Phase 1 — Discovery** — each of the six topics, with the answer or `Unresolved`
- **Phase 2 — Delivery** — each of the five topics, or `Unresolved — Delivery not started`
- **Phase 3 — Technical** — decisions, or `Unresolved — Technical not started`
- **Unresolved items** — every skip and every unfinished topic
- **Key decisions**

Tell the person the transcript is ready and they can generate the PRD from this interview.

## What this skill does not do

- Does not write production code.
- Does not fetch ADO work items.
- Does not generate the PRD. That is `/to-prd`, or Generate PRD on the interview.
- Does not create design docs or design specs.
- Does not modify files other than `context.md` and `.ai-pilot/kickoff-transcript.md`.
- Does not change this skill, and does not open it for editing.
