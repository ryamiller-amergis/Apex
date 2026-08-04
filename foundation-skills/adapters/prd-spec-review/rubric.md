# prd-spec-review — APEX rubric (adapter-owned)

## PRD markdown sections (weight sum = 100)

| Section | Weight |
|---------|--------|
| Frontmatter | 5 |
| Problem Statement | 8 |
| Proposed Solution | 8 |
| User story contract (backlog-owned) | 15 |
| Target Surface | 8 |
| Access Control and Permissions | 10 |
| Security and Data Sensitivity | 8 |
| Non-Functional Requirements | 7 |
| Feature Flag | 7 |
| Implementation Decisions | 8 |
| Assumptions Made | 8 |
| Apex Terminology Compliance | 7 |
| No Residual Template Tokens | 1 |

## Backlog JSON sections (weight sum = 100)

| Section | Weight |
|---------|--------|
| Personas | 8 |
| Business Rules | 10 |
| Epic structure | 10 |
| Feature structure | 10 |
| PBI user stories and structure | 12 |
| Acceptance Criteria coverage | 15 |
| TBI structure | 10 |
| dependsOn graph validity | 8 |
| Implementation Phases | 5 |
| assumptionsMade consistency with PRD | 7 |
| Schema compliance | 5 |

## Cross-cutting checks

| Check | Signal | Feeds into |
|-------|--------|-----------|
| Template token scan | `\{[A-Za-z][^}]*\}` in non-code content | No Residual Template Tokens |
| `[TBD]` / `TODO` / `FIXME` scan | Any match | No Residual Template Tokens |
| Persona enum compliance | Persona not in Apex groups enum | User story contract; Personas |
| Feature ↔ PBI persona alignment | PBI persona not in `affectedPersonas` | Feature structure; PBI structure |
| User story ↔ PBI traceability | Orphan PBI story | User story contract; PBI structure |
| PRD scope traceability | Backlog item not grounded in PRD narrative | Feature structure; PBI structure |
| Out of scope alignment | PRD vs backlog exclusion contradiction | Proposed Solution; Feature structure |
| Target surface alignment | PRD surface label vs backlog PBI/TBI behavior | Target Surface; PBI structure |
| NFR consistency | PRD NFR contradicts PBI/TBI fields | Non-Functional Requirements; PBI structure |
| Business rule traceability | Orphan `BR-NNN` reference | Business Rules; PBI structure |
| AC scenario coverage | PBI missing (a)-(d) rows | Acceptance Criteria coverage |
| dependsOn DAG validity | Cycle or dangling reference | dependsOn graph validity |
| Dependency locality (hard gate) | item-level `dependsOn` crosses Feature boundary | dependsOn graph validity |
| Implementation phase coverage | Epic not assigned to phase, or ordering contradicts deps | Implementation Phases |
| Feature flag alignment | PRD No + backlog flag present, or mismatch | Feature Flag; Feature structure |
| Terminology compliance | Non-canonical Apex term | Terminology Compliance |
