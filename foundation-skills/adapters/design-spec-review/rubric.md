# design-spec-review rubric (adapter-owned)

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
| Project terminology consistency | 12 |
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

| ID | Check | Signal | Feeds into |
|----|-------|--------|-----------|
| `template_tokens` | Template token scan | `\{[A-Za-z][^}]*\}` remains in any generated artifact | No residual template tokens |
| `tbd_markers` | `[TBD]` / `TODO` scan | Any unresolved placeholder marker appears in prose or structured fields | No residual template tokens |
| `work_item_coverage` | Work-item coverage | Referenced backlog item ID is absent from all three files | Feature Summary; Architecture and Approach |
| `ac_scenario_coverage` | Acceptance-criteria scenario coverage | Covered backlog item is missing required scenario rows such as happy path, validation, authorization, or failure handling | Acceptance Criteria |
| `terminology_consistency` | Project terminology consistency | A non-canonical project or domain term is used where a glossary-defined term exists | Project terminology consistency |
| `mermaid_keyword_presence` | Mermaid keyword presence | Diagram 1 lacks `sequenceDiagram`, or diagram 2 lacks `flowchart TD` | Mermaid Diagram 1 - Code Execution Flow; Mermaid Diagram 2 - Implementation Dependency Map |
| `warning_consolidation` | Warning consolidation | Design or tech spec records a warning without a matching assumptions entry | Cross-file consistency |
| `missing_files` | Missing files | Feature is missing one or more required artifacts, so section scores must fall to zero | All sections |
