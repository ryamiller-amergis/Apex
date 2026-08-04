# design-doc-validation — APEX rubric (adapter-owned)

Section weight tables and cross-cutting checks for APEX design docs. Score every
score on the 0-3 scale from the foundation.

## Design Doc sections (weight sum = 100) — EXHAUSTIVE

| Section | Weight | What to look for |
|---------|--------|-----------------|
| Feature Summary | 10 | PRD slug, priority, feature flag, parent Epic, affected personas; 2-3 sentence narrative; work-item index table |
| Scope and Out-of-Scope | 7 | In-scope and out-of-scope merged from Feature and PBI/TBI arrays |
| Acceptance Criteria | 25 | Consolidated Given/When/Then; all four scenarios (happy, error, edge, negative) per PBI |
| Target Surface | 8 | One canonical surface label plus experience notes |
| Access Control | 10 | Action/who/scope table; feature flag name, rollout, disabled behavior |
| UI/UX | 12 | Routes, component breakdown with states, validation, accessibility, data-testid; "Not applicable" for backend-only |
| Tech spec link | 5 | Relative link to `{feature-slug}-tech-spec.md` |
| Assumptions link | 5 | Link to `{feature-slug}-assumptions.md` with unresolved count |
| Apex terminology compliance | 12 | Uses Apex glossary terms correctly |
| No residual template tokens | 6 | Zero `{token}`, `[TBD]`, or `TODO` |

## Tech Spec sections (weight sum = 100) — EXHAUSTIVE

| Section | Weight | What to look for |
|---------|--------|-----------------|
| System Boundary and Owning Layer | 10 | Owning layer + rationale; answers the 5 Apex ownership questions |
| Security Enforcement | 7 | Authorization citing existing RBAC pattern; scope enforcement; sensitive data |
| Architecture and Approach | 14 | Layers-touched table; per-PBI/TBI decisions citing codebase patterns |
| Data and Contracts | 10 | API endpoints (method, route, req/resp, auth); schema changes (intent, no DDL) |
| Testing Strategy | 10 | Unit, integration, E2E guidance with module names and behaviors |
| Verification Test Matrix | 14 | VT-xx rows with Layer, Arrange, Act, Assert, linked PBI/TBI |
| Implementation Plan | 10 | Ordered checkable steps with VT-xx references and blocked-by notes |
| Mermaid Diagram 1 — Code Execution Flow | 4 | Valid `sequenceDiagram` with request/response chain + `alt` error block |
| Mermaid Diagram 2 — Implementation Dependency Map | 3 | Valid `flowchart TD` with step nodes, parallel subgraphs, test nodes, legend |
| Observability | 5 | Custom events/metrics or "None beyond standard telemetry"; alerts |
| Rollback and Deployment | 5 | Schema backward compatibility; rollback; deployment deps; feature flag gate |
| No residual template tokens | 8 | Zero `{token}`, `[TBD]`, or `TODO` |

## Assumptions sections (weight sum = 100) — EXHAUSTIVE

| Section | Weight | What to look for |
|---------|--------|-----------------|
| Header metadata | 10 | PRD slug, priority, feature flag (or None), relative links to design doc and tech spec |
| Unresolved Items | 40 | Each warning has label, question, impact, decision needed; or "None — all resolved" |
| Assumptions Accepted | 40 | Each assumption has label, what was assumed, derivation source, risk if wrong |
| Cross-file consistency | 10 | Every warning in design/tech-spec has a matching assumptions entry |

## Cross-cutting checks (run ONLY these)

| Check | How |
|-------|-----|
| Template token scan | Count `\{[A-Za-z][^}]*\}` matches |
| `[TBD]` / `TODO` scan | Count matches |
| Terminology compliance | Flag non-canonical Apex terms; do not flag feature-domain terms |
| Warning consolidation | Every warning in design/tech-spec must have a matching assumptions entry |
| Mermaid keyword presence | `sequenceDiagram` in diagram 1, `flowchart TD` in diagram 2 |
| AC scenario coverage | Every PBI has all 4 scenarios (happy, error, edge, negative) |
