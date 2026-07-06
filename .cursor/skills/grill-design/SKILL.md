---
name: grill-design
description: Technical design interview that takes a feature request (by ID or free-form description) and conducts deep technical discussions on architecture, module design, and implementation approach before grilling into feature scope for PRD generation. Use when the user wants to explore the best technical approach for a module, discuss architecture trade-offs, or have a design-focused interview that leads to structured requirements.
---

# Grill Design

## When to load this skill

Load immediately when any of the following are true:

- The user sends `/grill-design`.
- The user asks for a "technical design discussion", "architecture review", "design interview", or "module design session".
- The user wants to discuss the best technical approach for building a feature before creating a PRD.
- The user has a feature request and wants to explore implementation options before formalizing requirements.

---

## How to invoke

```
/grill-design                          — free-form: user describes the feature in chat
/grill-design FR-123                   — loads feature request #123 from the database
/grill-design "Build a notification preferences panel"  — inline description
```

---

## Phase 0 — Load the feature request

### If a feature request ID is provided:

1. Query the `feature_requests` table via the feature request service to load the title, description, expected advantage, AI analysis (priority, risk, rationale), and current status.
2. Read `context.md` and `AGENTS.md` for product context.
3. Present the loaded feature request to the user: "Here's what I loaded — let me know if anything needs correction before we start."

### If a free-form description is provided:

1. Read `context.md` and `AGENTS.md` for product context.
2. Ask the user to confirm: "Here's my understanding of what you want to build: {restatement}. Correct?"

### Pre-read (do this before the first question)

1. Read `context.md` (repo root) — product context, features, terminology. **Mandatory.**
2. Read `AGENTS.md` (repo root) — feature map, directory structure, service files. **Mandatory.**
3. Scan `design-docs/` file names — know what's already been designed.
4. Based on the feature description, do a targeted codebase scan (2–3 Grep/Read calls) to understand the current state of the area being discussed.

---

## Phase 1 — Technical discovery (architecture-first)

This phase focuses on **how** to build it before **what** to build. Ask questions using the **AskQuestion tool** — one at a time, wait for the answer, acknowledge it, then ask the next.

### Mandatory technical questions (ask in order):

**T1 — Existing patterns and prior art**

Scan the codebase for the closest existing feature to what's being proposed. Present your findings:

> "The closest existing pattern is {feature X}, which uses {service → route → hook → component}. Should we follow this pattern, extend it, or build something new?"

- Options: `Follow existing pattern` | `Extend existing pattern` | `New approach — explain why`

**T2 — Module boundaries**

Ask where the new capability should live in the architecture. Reference existing services and the directory structure from `AGENTS.md`.

> "Should this be a new service (like `featureRequestService.ts`), an extension of an existing service (like adding methods to `interviewService.ts`), or a cross-cutting concern?"

- Propose your recommendation based on the codebase scan.

**T3 — Data model**

Ask what data needs to be stored, whether it extends existing tables or needs new ones, and what the relationships look like.

- Options: `Extend existing table(s) — name them` | `New table(s) needed` | `No persistence needed (in-memory/derived)` | `External data source (ADO, AI API, etc.)`
- If new tables: sketch the columns and relationships in prose. Reference `postgresql-db.mdc` conventions.

**T4 — API surface**

Ask what endpoints or server actions are needed. For each, propose the HTTP method, route pattern, request/response shape, and auth requirements.

- Reference existing route patterns in `src/server/routes/api.ts`.
- Check RBAC implications per `.cursor/rules/rbac-governance.mdc`.

**T5 — Client architecture**

Ask how the UI should be structured. Reference existing component patterns.

- What views/pages are needed?
- What hooks are needed (TanStack Query patterns)?
- What shared types bridge client and server?
- What existing components can be reused?

**T6 — AI integration (if applicable)**

If the feature involves AI capabilities:

- Which AI model(s) should be used?
- Should it use the existing `chatAgentService.ts` pattern?
- Does it need streaming (SSE)?
- Does it need a new skill file?

---

## Phase 2 — Feature grilling (scope and requirements)

After technical decisions are resolved, shift to feature-level grilling. This mirrors the `grill-with-docs` mandatory questions but is informed by the technical decisions made in Phase 1.

### Mandatory feature questions (same as grill-with-docs Q1–Q5):

**Q1 — Surface (frontend vs. backend vs. full-stack)**

- Options: `Frontend only (React client)` | `Backend only (Express server)` | `Full-stack (both client and server)` | `Shared types only` | `Database migration only`

**Q2 — Access control**

- Group options: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin (Super Admin)`, `Project Admin`
- RBAC role options: `admin`, `member`, `viewer`
- Data scope options: `Project-scoped` | `User-scoped (self-only)` | `Global (all projects)` | `No scope restriction`

**Q3 — Data sensitivity**

- Options: `Yes — identify fields` | `No — none involved` | `Uncertain — needs data model review`

**Q4 — Non-functional requirements**

- Response time, concurrent users, data volume bounds.

**Q5 — Feature flag rollout**

- Options: `No flag needed — ship directly` | `Flag required — internal first then gradual rollout` | `Flag required — team will define sequence`

---

## Phase 3 — Deep-dive grilling loop

After the mandatory questions, enter the grilling loop. Interview the user **relentlessly** until you reach a shared, precise understanding of both the technical design and feature requirements.

**Ask questions one at a time.** Use the **AskQuestion tool** for each question.

### Apply these lenses (same as grill-with-docs, plus technical depth):

**1. Challenge against the product context** — cross-reference `context.md` and `AGENTS.md`.

**2. Sharpen fuzzy language** — propose precise terms.

**3. Discuss concrete scenarios** — stress-test with edge cases.

**4. Cross-reference with code** — verify assertions against the codebase.

**5. Own the recommendation** — state your preferred approach and ask for confirmation.

**6. Challenge architecture decisions** (unique to grill-design):

When the user proposes an approach, challenge it with alternatives:

> "You suggested adding a new route file for this feature. However, every existing feature route is registered in `src/server/routes/api.ts`. Breaking that pattern means agents and developers need to check two places. I recommend following the existing pattern. Do you agree?"

**7. Evaluate module depth** (unique to grill-design):

For each proposed module, evaluate whether it's a deep module (significant logic behind a simple interface) or a shallow module (thin wrapper). Prefer deep modules.

> "This service would just forward calls to the AI API with no business logic — that's a shallow module. Consider combining it with {existing service} which already handles similar AI orchestration."

---

## Transcript persistence

When the session ends:

1. Create `.ai-pilot/kickoff-transcript.md` — structured summary of the entire session.
2. Format with clear sections:
   - **Feature Request** (source: ID or free-form)
   - **Technical Discovery (T1–T6)** — all architecture decisions
   - **Feature Scope (Q1–Q5)** — all feature-level decisions
   - **Deep-Dive Decisions** — grilling loop outcomes
   - **Unresolved Assumptions** — flagged with `⚠`
   - **Proposed Architecture Summary** — brief architecture overview including:
     - Services to create/modify
     - Database changes
     - API endpoints
     - Client components
     - AI integration (if any)
3. This file is the sole input for `/to-prd`.

Tell the user: "Session complete. Run `/to-prd` when you're ready to generate the PRD from this transcript."

---

## What this skill does NOT do

- Does not write production code.
- Does not generate PRDs (that is `/to-prd`'s job).
- Does not create design docs or design specs.
- Does not modify files outside of `context.md` and `.ai-pilot/kickoff-transcript.md`.
- Does not automatically chain to `/to-prd` — the user triggers that manually.
