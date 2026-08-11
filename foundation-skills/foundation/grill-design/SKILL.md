---
name: grill-design
description: Technical design interview that takes a feature request or free-form description and conducts deep technical discussions on architecture, module design, and implementation approach before producing structured requirements. Use when the user wants to explore the best technical approach for a module, discuss architecture trade-offs, or have a design-focused interview.
---

# Grill Design — Foundation

Technical design interview: explore architecture, make hard choices explicit, and produce a kickoff transcript suitable for PRD generation.

## Linked context pre-read

If `.ai-pilot/linked-context.md` is present in the workspace, read it before proceeding. Treat its provenance-labeled sections as authoritative project grounding. If it is absent, proceed normally.

## When to load

- The user wants to discuss technical architecture before writing a PRD.
- The user needs to choose between implementation approaches.
- A feature involves significant technical trade-offs.

## Pre-read

Load the project adapter for context on the project's tech stack, architectural patterns, and existing modules before the first question.

## Opening questions (ask in order, one at a time)

1. What is being built, replaced, or refactored?
2. What are the hard technical constraints (performance, security, compatibility, delivery date)?
3. Is there an existing implementation to understand first?

## Design interview loop

- Ask exactly one focused technical question per response.
- Always present 2–3 concrete options with trade-offs. Put your recommendation first.
- Test: failure modes, scale limits, migration path, observability, security, team ownership, and long-term maintenance burden.
- Resolve contradictory constraints and ambiguous terms before moving on.
- Ground recommendations in actual repository patterns (use available tools to inspect the codebase).

## Technical areas to cover

- Module/service boundaries and ownership
- Data model and persistence
- API contracts (shape, auth, versioning)
- Error handling and rollback
- Performance characteristics and limits
- Security and access control
- Testing approach per layer
- Migration / backward compatibility

## Wrap-up

When the technical design is sufficiently clear, write `.ai-pilot/kickoff-transcript.md` with:
- Problem and technical scope
- Repository evidence
- Hard constraints
- Architecture decisions made
- Rejected alternatives and why
- Open risks

Tell the user the transcript is ready for PRD generation.
