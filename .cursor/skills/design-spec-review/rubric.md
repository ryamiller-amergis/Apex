# Design Spec Review — Scoring Rubric (Apex)

All three file types use a 0–3 scale per section. The confidence score formula is:

```
per-file score = (Σ section_score × section_weight) / (3 × Σ section_weight) × 100
```

File weights within a Feature: **design 35%, tech-spec 45%, assumptions 20%**.
Overall score: unweighted average across all Features.

---

## Canonical Apex Enums (use ONLY these values — do not substitute or invent alternatives)

### Persona names (Apex groups enum)
`Product-Owner`, `BA`, `UI/UX`, `Manager`, `Developer`, `QA`, `Platform Admin`, `Project Admin`, `Authenticated User`

### Target surface labels
`Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`

### Apex glossary terms
`Interview`, `PRD`, `Design Doc`, `Design Prototype`, `PBI`, `TBI`, `Feature Flag`, `Skill`, `Backlog`, `Epic`, `Feature`, `RBAC`, `SSE`, `Facilitator`

### System Boundary ownership questions (Apex-specific)
1. New or existing Express service in `src/server/services/`?
2. New or existing route in `src/server/routes/`?
3. New React component in `src/client/components/`?
4. New shared type in `src/shared/types/`?
5. Database migration needed?

**CRITICAL:** Apex is a product-building platform — it is NOT a timeclock, staffing, or healthcare application. Do not apply domain terms, personas, or project names from other products. Score **only** against the enums and section lists defined in this rubric. Do NOT invent or check sections not listed in the rubric tables below.

---

## Score Scale

| Score | Label | Meaning |
|-------|-------|---------|
| 0 | Missing | Section absent, or body is still a template placeholder (`{...}`) or `[TBD]` |
| 1 | Shallow | Section header present with minimal or generic content |
| 2 | Substantive | Addresses intent with specific, named modules/routes/layers; grounded in codebase |
| 3 | Complete | Actionable, cross-referenced, and traceable; an implementer could work from this alone |

---

## Design Doc (`{feature-slug}-design.md`)

### Feature Summary — weight 10

| Score | Evidence |
|-------|----------|
| 0 | Section missing or template tokens in description |
| 1 | Description present but generic; work-item table empty |
| 2 | Business narrative in 2–3 sentences; work-item table lists IDs |
| 3 | Narrative names problem, beneficiary, and end-state; full work-item index; links to assumptions file |

### Scope and Out-of-Scope — weight 7

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Placeholder list items |
| 2 | In-scope and out-of-scope each have 2+ concrete points |
| 3 | In-scope names specific behaviors; out-of-scope merged from all PBI/TBI arrays |

### Acceptance Criteria — weight 25

| Score | Evidence |
|-------|----------|
| 0 | Section missing or template placeholders |
| 1 | Some Given/When/Then rows but not all 4 scenarios |
| 2 | All 4 scenarios for most PBIs; minor gaps |
| 3 | Every PBI has all 4 rows with concrete, testable Then clauses |

### Target Surface — weight 8

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Surface label present but not from allowed values (`Frontend only (React client)`, `Backend only (Express server)`, `Full-stack (both client and server)`, `Shared types only`, `Database migration only`) |
| 2 | Valid label; notes incomplete |
| 3 | Valid surface label with appropriate experience notes |

### Access Control — weight 10

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Groups listed but no data scope; feature flag missing |
| 2 | Table complete; feature flag documented |
| 3 | Full table; feature flag with rollout and disabled behavior; "Not applicable" only for backend-only |

### UI/UX — weight 12

| Score | Evidence |
|-------|----------|
| 0 | Section missing (when Feature has frontend PBIs) |
| 1 | Target surface stated but no component breakdown |
| 2 | Routes and components present; some states defined |
| 3 | Full component table with all states; validation; accessibility; `data-testid`; "Not applicable" for backend-only |

### Tech Spec Link — weight 5

| Score | Evidence |
|-------|----------|
| 0 | Link missing |
| 1 | Link present but wrong filename |
| 3 | Correct relative link |

### Assumptions Link — weight 5

| Score | Evidence |
|-------|----------|
| 0 | Link missing |
| 1 | Link present but no unresolved count |
| 3 | Link with unresolved item count |

### Apex Terminology Compliance — weight 12

Check against the Apex glossary terms listed at the top of this rubric. Do NOT flag domain terms specific to the feature being designed.

| Score | Evidence |
|-------|----------|
| 0 | Multiple non-canonical Apex platform terms (3+) |
| 1 | 1–2 non-canonical Apex term uses |
| 2 | Canonical Apex terms mostly correct; 1 slip |
| 3 | All Apex platform terms correct: Interview, PRD, Design Doc, Design Prototype, PBI, TBI, Feature Flag, Skill, Backlog, Epic, Feature |

### No Residual Template Tokens — weight 6

| Score | Evidence |
|-------|----------|
| 0 | 3+ `{token}` or `[TBD]` patterns |
| 1 | 1–2 patterns |
| 2 | No `{token}`; `TODO` comments present |
| 3 | Zero `{token}`, `[TBD]`, or `TODO` patterns |

---

## Tech Spec (`{feature-slug}-tech-spec.md`)

### System Boundary and Owning Layer — weight 10

The 5 Apex ownership questions are: (1) Express service in `src/server/services/`? (2) Route in `src/server/routes/`? (3) React component in `src/client/components/`? (4) Shared type in `src/shared/types/`? (5) Database migration?

| Score | Evidence |
|-------|----------|
| 0 | Section missing or placeholder project |
| 1 | Layer named but ownership questions unanswered |
| 2 | Layer named with rationale; most of the 5 Apex ownership questions answered |
| 3 | Layer named; all 5 ownership questions answered with Yes/No + reason |

### Security Enforcement — weight 7

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Authorization named but no codebase citation |
| 2 | Cites existing RBAC pattern; scope layer stated |
| 3 | Cites closest existing pattern; scope enforcement layer stated; sensitive data addressed |

### Architecture and Approach — weight 14

| Score | Evidence |
|-------|----------|
| 0 | Section missing or all placeholder values |
| 1 | Layers table complete but per-work-item decisions absent |
| 2 | Layers table plus per-PBI/TBI decisions naming a pattern |
| 3 | Layers table; every decision cites closest reference in codebase and rejects an alternative |

### Data and Contracts — weight 10

| Score | Evidence |
|-------|----------|
| 0 | Section missing or all template rows |
| 1 | API table present but incomplete |
| 2 | API endpoints and schema changes specified |
| 3 | All sub-sections complete with concrete shapes; or explicit "Not applicable" with reason |

### Testing Strategy — weight 10

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Generic "write tests" statements |
| 2 | Module-level guidance; one layer underspecified |
| 3 | All layers specified with concrete module names and behaviors |

### Verification Test Matrix — weight 14

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Rows present but generic Arrange/Act/Assert |
| 2 | VT-xx rows with concrete values; most linked to PBI ids |
| 3 | Every behavior has a VT-xx row with precise Assert and linked AC scenario |

### Implementation Plan — weight 10

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Unordered steps; no VT references |
| 2 | Ordered steps with VT references; execution lanes missing |
| 3 | Checkable steps with VT ids, blocked-by, and execution lanes |

### Mermaid Diagram 1 — weight 4

| Score | Evidence |
|-------|----------|
| 0 | Diagram missing |
| 1 | Present but not a `sequenceDiagram` |
| 2 | `sequenceDiagram` with participants; no `alt` block |
| 3 | Valid `sequenceDiagram`; full request/response chain; `alt` error block |

### Mermaid Diagram 2 — weight 3

| Score | Evidence |
|-------|----------|
| 0 | Diagram missing |
| 1 | Present but not `flowchart TD` |
| 2 | `flowchart TD` with steps; legend or parallel missing |
| 3 | Valid `flowchart TD`; parallel subgraphs; test nodes; legend |

### Observability — weight 5

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Only "standard telemetry" with no specifics |
| 2 | Events listed; alerts missing |
| 3 | Custom events with triggers; alerts stated (or "None"); healthy vs degraded described |

### Rollback and Deployment — weight 5

| Score | Evidence |
|-------|----------|
| 0 | Section missing |
| 1 | Schema compatibility stated but no rollback or dependencies |
| 2 | Compatibility and rollback addressed; dependencies incomplete |
| 3 | Schema compatibility answered; rollback steps; dependencies listed; feature flag gate stated |

### No Residual Template Tokens — weight 8

| Score | Evidence |
|-------|----------|
| 0 | 3+ `{token}` or `[TBD]` patterns |
| 1 | 1–2 patterns |
| 3 | Zero patterns |

---

## Assumptions File (`{feature-slug}-assumptions.md`)

### Header Metadata — weight 10

| Score | Evidence |
|-------|----------|
| 0 | Header missing or has placeholders |
| 1 | Some fields present; links missing |
| 3 | PRD slug, priority, feature flag, and links to both design and tech spec present |

### Unresolved Items — weight 40

| Score | Evidence |
|-------|----------|
| 0 | Section missing or template-only |
| 1 | Items listed without impact |
| 2 | Each `⚠` has question and why it matters |
| 3 | Every `⚠` has: label, question, impact, decision needed; or "None — all resolved" |

### Assumptions Accepted — weight 40

| Score | Evidence |
|-------|----------|
| 0 | Section missing or template-only |
| 1 | Items without derivation or risk |
| 2 | Each assumption states what and derivation |
| 3 | Every assumption has: label, what, derivation source, risk if wrong |

### Cross-file Consistency — weight 10

| Score | Evidence |
|-------|----------|
| 0 | `⚠` items in design/tech-spec without matching entry here |
| 1 | Most consolidated; 1–2 missing |
| 3 | Every `⚠` marker has a corresponding entry |
