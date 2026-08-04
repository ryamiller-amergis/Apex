---
name: kick-off
description: Conducts a feature kick-off interview and produces a design document. Use when starting a new feature or when the user requests a design doc kick-off interview.
---

# Kick-Off — Foundation

Conduct a feature kick-off interview and produce a design document.

## Pre-read

Load the project adapter for project-specific terminology, feature map, and design doc template path.

## Interview phases

### Phase 1 — Feature identity (ask in order, one at a time)

1. What is the feature name and one-sentence description?
2. Which user personas does this feature serve?
3. What problem does it solve (user job-to-be-done)?

### Phase 2 — Scope definition

4. What is explicitly in scope for this feature?
5. What is out of scope?
6. Are there dependencies on other features, systems, or services?

### Phase 3 — Technical discovery

7. Which surface(s) does this touch: frontend, backend, database, or external system?
8. Are there existing patterns in the codebase to follow or avoid?
9. What are the key acceptance criteria?

### Phase 4 — Risks and rollout

10. What could go wrong with this feature?
11. Should this be gated by a feature flag?
12. Is there a rollback plan?

## Output

Write a design document to `.ai-pilot/output/{slug}-design.md` using the project's design doc template (from the project adapter).

The design doc must include:
- Feature summary and user impact
- In scope / out of scope
- User stories with acceptance criteria
- Technical approach summary
- Security and access control
- Open questions and risks
