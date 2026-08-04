# Design — {Feature Title}

> **PRD slug:** `{slug}` | **Priority:** {MoSCoW} | **Feature flag:** `{flag-key or None}`
> **Parent Epic:** {Epic Title} | **Affected personas:** {comma-separated}
> **Open items:** See [{feature-slug}-assumptions.md]({feature-slug}-assumptions.md) ({n} unresolved)

---

## Feature Summary

**Description:** {2–3 sentence business narrative. Problem being solved, who benefits, what the end state looks like.}

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-001 | PBI | {title} | Must Have |
| TBI-001 | TBI | {title} | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- {What this Feature explicitly covers}

**Out of scope:**
- {Merged from Feature.outOfScope and PBI/TBI outOfScope}

---

## Target Surface

**Primary surface:** {Frontend only (React client) | Backend only (Express server) | Full-stack | Shared types only | Database migration only}

**Experience notes:** {Relevant UX notes or "Not applicable"}

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| {action} | {group/role} | {Project-scoped | User-scoped | Global | No restriction} |

**Feature flag:** `{flag-key}` — rollout: {sequence or None}
**Behavior when flag is off:** {description or "Not applicable"}

---

## Acceptance Criteria

### PBI-001 — {title}

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | {setup} | {action} | {outcome} |
| (b) Error/failure | {setup} | {action} | {outcome} |
| (c) Edge case/boundary | {setup} | {action} | {outcome} |
| (d) Negative scenario | {setup} | {action} | {outcome} |

<!-- Repeat table for each PBI -->

---

## UI/UX

<!-- Replace with "Not applicable." for backend-only features -->

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| `/path` | {ScreenName} | {what the user does} | Extend existing |

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `{ComponentName}` | {purpose} | {spinner/skeleton/none} | {inline/toast/modal} | {message or zero-state} |

**Validation rules:**
- {Field or interaction}: {rule}

**Accessibility:**
- {aria-label, role, or keyboard behavior requirements}

**data-testid attributes:**
- `data-testid="{id}"` — {what it marks}

---

## Technical Specification

See [{feature-slug}-tech-spec.md]({feature-slug}-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
