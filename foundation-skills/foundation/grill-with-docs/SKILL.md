---
name: grill-with-docs
description: Relentless interview that stress-tests a feature plan against the codebase, sharpens domain terminology, and surfaces contradictions. Use when the user wants to pressure-test a design or vet a feature plan before PRD generation.
---

# Grill With Docs — Foundation

Stress-test a feature plan against the project's documentation and codebase before PRD generation.

## Linked context pre-read

If `.ai-pilot/linked-context.md` is present in the workspace, read it before proceeding. Treat its provenance-labeled sections as authoritative project grounding. If it is absent, proceed normally.

## Pre-read (before the first question)

Load the project adapter and read:
1. The project's primary context/documentation guide
2. The project's AGENTS.md equivalent
3. Scan file names in the design docs directory — note existing design doc titles to avoid re-litigating prior decisions

## Opening questions (ask in order, one at a time)

1. **Surface** — is this frontend, backend, or full-stack?
2. **Access control** — which roles/permissions are involved?
3. **Data** — what is the data model and how does it integrate with existing entities?
4. **Edge cases** — what happens when inputs are invalid, data is missing, or a dependent system fails?
5. **Rollout** — should this be gated by a feature flag? What is the rollback plan?

## Grilling loop

- Ask exactly one question per response.
- Surface contradictions between the plan and existing code/docs.
- Resolve fuzzy terms against the project's canonical terminology.
- Challenge assumptions about user behavior, scale, and dependencies.
- Always verify claims against the codebase using available tools.

## Wrap-up

When the feature is sufficiently vetted, write `.ai-pilot/kickoff-transcript.md` with:
- Verified feature scope
- Contradictions resolved
- Edge cases documented
- Open questions and risks

Tell the user the transcript is ready for PRD generation.
