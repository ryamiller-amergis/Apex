---
name: grill-with-docs
description: Relentless interview session that stress-tests a feature plan against context.md, AGENTS.md, existing design docs, and the live codebase. Sharpens domain terminology, surfaces contradictions, and captures precise requirements. Use when the user wants to pressure-test a design, sharpen domain language, or thoroughly vet a feature plan before PRD generation.
---

# Grill With Docs

## When to load this skill

Load immediately when any of the following are true:

- The user sends `/grill-with-docs`.
- The user asks to "stress-test", "grill", "pressure-test", "challenge", or "sharpen" a plan or design.
- The user wants to resolve what the canonical term for a concept is.
- The user asks to start a feature interview focused on building a new feature or enhancement.

---

## How to invoke

```
/grill-with-docs
```

No arguments. The session runs against whatever plan, design, or idea is currently active in the chat. If nothing is stated, ask the user to describe what they want to grill before starting.

---

## Pre-read (do this before the first question)

1. Read `context.md` (repo root) — the product context guide. Know the features, terminology, and workflows. This is the only mandatory pre-read.
2. Read `AGENTS.md` (repo root) — the feature map, directory structure, and key file references. Use this to cross-reference service boundaries and locate relevant code.
3. Scan file names in `design-docs/` — note existing design doc titles so you don't re-litigate prior decisions. Only open a design doc when a question directly touches that area.

Do not ask the user a question until step 1 is complete. Steps 2–3 are deferred lookups, not blocking pre-reads.

---

## Mandatory opening questions (ask these first, in order)

Before the free-form grilling loop, ask these five questions using the **AskQuestion tool** — one at a time, wait for the answer, acknowledge it, then move to the next. These fire for every grill session regardless of feature type. Do not skip any of them, and do not ask them all at once.

**Q1 — Surface (frontend vs. backend vs. full-stack)**

Ask whether the feature will be on the frontend (React client), backend (Express server), or full-stack. If the work item description already answers this, surface what you found and only ask if ambiguity remains.

- Options: `Frontend only (React client)` | `Backend only (Express server)` | `Full-stack (both client and server)` | `Shared types only` | `Database migration only`
- Hold the answer: it drives layer routing, UI/UX scope in the design doc, and which skills apply.

**Q2 — Access control**

Ask which groups/roles can perform each action and what data scope applies. If the feature area maps to a known route or service, check that route for existing RBAC guards (limit to 1–2 targeted Grep calls). Surface what you found and ask only where ambiguity remains.

- Group options: `Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin (Super Admin)`, `Project Admin`
- RBAC role options: `admin`, `member`, `viewer`
- Data scope options: `Project-scoped` | `User-scoped (self-only)` | `Global (all projects)` | `No scope restriction`
- Authorization is an acceptance criterion, not an implementation detail. It must be resolved here.

**Q3 — Data sensitivity**

Ask whether any fields involved contain sensitive data (credentials, tokens, PII).

- Options: `Yes — identify fields` | `No — none involved` | `Uncertain — needs data model review`
- If "Yes": follow up asking which fields and what handling is required. Options: `Encrypt at rest` | `Mask in logs` | `Exclude from API responses` | `All three` | `Other — describe`
- If "Uncertain": flag it as a `⚠ Unresolved` item for the assumptions file.
- If "No": move on.

**Q4 — Non-functional requirements**

Ask what the acceptable performance bounds are for the primary user action in this feature. If the user is uncertain, propose reasonable defaults based on similar existing features and ask them to confirm or override.

Specifically ask about:
- Response time (e.g., "API responds within 2 seconds at P95")
- Concurrent users (e.g., "Supports up to 100 simultaneous users")
- Data volume (e.g., "Query returns up to 500 records; pagination required above 50")

Do not accept "we'll figure it out later" — record the answer as a requirement, not an assumption.

**Q5 — Feature flag rollout**

Ask whether this feature will be gated behind a feature flag. If yes, ask three follow-up questions in one message: rollout sequence, kill switch owner, and behavior when disabled.

- Options: `No flag needed — ship directly` | `Flag required — internal first then gradual rollout` | `Flag required — team will define sequence`
- If a flag is confirmed, ask: what is the flag key (or "TBD"), who enables it for each tier, and what does the user see when the flag is off (hidden entirely, read-only, degraded mode, etc.)?

---

## The grilling loop

Interview the user **relentlessly** until you reach a shared, precise understanding of the plan. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

**Ask questions one at a time.** Use the **AskQuestion tool** for each question (never render questions as plain markdown). One `AskQuestion` call per message, wait for the answer, acknowledge it, then ask the next.

If a question can be answered by **exploring the codebase** (using Grep, Read, or Glob), do that instead of asking the human — but **limit exploration to 2 tool calls per question**. If ambiguity remains after 2 calls, surface what you found and ask the user to clarify. If exploration hits its cap and a gap remains, flag it as a `⚠ Unresolved assumption` in your acknowledgment so it carries forward to to-prd.

### During the session, apply these five lenses:

**1. Challenge against the product context**

When the user uses a term that conflicts with or is undefined in `context.md` or `AGENTS.md`, call it out immediately before moving on.

> "context.md defines 'Interview' as an AI-guided design conversation. You used 'interview' to describe a user survey — do you mean a new type of interview, or something else?"

**2. Sharpen fuzzy language**

When the user uses vague or overloaded terms, propose a precise canonical term and ask them to confirm.

> "You said 'document' — do you mean a PRD, a Design Doc, or a Design Prototype? Those are different artifacts in Apex."

**3. Discuss concrete scenarios**

When domain relationships are being discussed, stress-test them with specific scenarios. Invent edge cases that force the user to be precise about boundaries.

> "If a user has both BA and Developer group membership, which interview actions can they perform? Can a Developer start an interview, or only participate as a reviewer?"

**4. Cross-reference with code**

When the user asserts how something works, check whether the code agrees. Read the relevant files:

- RBAC assertions → `.cursor/rules/rbac-governance.mdc`
- Database patterns → `.cursor/rules/postgresql-db.mdc`
- Service layer assertions → check relevant `src/server/services/` files
- UI assertions → check relevant `src/client/components/` files
- Shared types → check `src/shared/types/`

If you find a contradiction, surface it:

> "Your design says notifications should be sent via the standup service, but `notificationService.ts` is the canonical notification dispatcher — standup just calls into it. Should we follow the existing pattern?"

**5. Own the recommendation**

Do not ask open-ended questions when one answer is clearly better. State your recommendation and ask the user to confirm or override.

> "I recommend adding this as a new route in `src/server/routes/api.ts` rather than a separate route file because all feature routes follow that pattern. Do you agree, or do you have a reason to separate it?"

---

## Update context.md inline

When a term is resolved and you have write access, update `context.md` right there. Don't batch these up — capture them as they happen. Use the format below:

```markdown
### {Term}

- **Definition:** One sentence, domain-meaningful. Write what the term means to a domain expert, not to an implementer.
- **Use when:** The canonical context in which this term applies.
- **Don't confuse with:** Sibling or overloaded terms — name each one and explain the distinction.
```

If running in a **read-only or web agent context** where file writes are unavailable, collect term resolutions in your chat response with the prefix `📌 CONTEXT update:` so they are captured in the transcript and can be applied later.

`context.md` should be totally devoid of implementation details. It is a product context guide and glossary.

---

## Transcript persistence

When the grilling session ends (user says "done", "that's enough", "wrap up", or explicitly ends the interview):

1. Create `.ai-pilot/kickoff-transcript.md` — a structured summary of the entire session including all Q&A, decisions made, and unresolved items.
2. Format the transcript with clear sections: **Feature Description**, **Opening Questions (Q1–Q5)**, **Grilling Decisions**, **Unresolved Assumptions**, **Key Design Decisions**.
3. This file is the sole input for `/to-prd`.

---

## What this skill does NOT do

- Does not write production code.
- Does not fetch ADO work items.
- Does not generate PRDs (that is `/to-prd`'s job).
- Does not create design docs or design specs.
- Does not modify files outside of `context.md` and `.ai-pilot/kickoff-transcript.md`.
