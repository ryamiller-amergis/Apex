# design-spec-review — APEX rubric (adapter-owned)

## Design doc sections (weight sum = 100)

| Section | Weight |
|---------|--------|
| Feature Summary | 10 |
| Scope and Out-of-Scope | 7 |
| Acceptance Criteria | 25 |
| Target Surface | 8 |
| Access Control | 10 |
| UI/UX | 12 |
| Tech spec link | 5 |
| Assumptions link | 5 |
| Apex terminology compliance | 12 |
| No residual template tokens | 6 |

## Tech spec sections (weight sum = 100)

| Section | Weight |
|---------|--------|
| System Boundary and Owning Layer | 10 |
| Security Enforcement | 7 |
| Architecture and Approach | 14 |
| Data and Contracts | 10 |
| Testing Strategy | 10 |
| Verification Test Matrix | 14 |
| Implementation Plan | 10 |
| Mermaid Diagram 1 — Code Execution Flow | 4 |
| Mermaid Diagram 2 — Implementation Dependency Map | 3 |
| Observability | 5 |
| Rollback and Deployment | 5 |
| No residual template tokens | 8 |

## Assumptions sections (weight sum = 100)

| Section | Weight |
|---------|--------|
| Header metadata | 10 |
| Unresolved Items | 40 |
| Assumptions Accepted | 40 |
| Cross-file consistency | 10 |

## Cross-cutting checks

| Check | Signal | Feeds into |
|-------|--------|-----------|
| Template token scan | `\{[A-Za-z][^}]*\}` | No residual template tokens |
| `[TBD]` / `TODO` scan | Any match | No residual template tokens |
| PBI/TBI coverage | ID absent from all 3 files | Architecture; Feature Summary |
| AC scenario coverage | PBI missing (a)-(d) rows | Acceptance Criteria |
| Terminology compliance | Non-canonical Apex platform term | Terminology compliance |
| Mermaid keyword presence | `sequenceDiagram` in diagram 1, `flowchart TD` in diagram 2 | Mermaid diagrams |
| `⚠` consolidation | `⚠` in design/tech-spec without assumptions entry | Cross-file consistency |
| Missing files | Feature without all 3 files — score 0 on all sections | All sections |
