# prd-spec-review rubric (adapter-owned)

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
| Project Terminology Consistency | 7 |
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

| ID | Check | Signal | Feeds into |
|----|-------|--------|-----------|
| `template_tokens` | Template token scan | `\{[A-Za-z][^}]*\}` appears in non-code content | No Residual Template Tokens |
| `tbd_markers` | `[TBD]` / `TODO` / `FIXME` scan | Any unresolved placeholder marker appears in prose or structured fields | No Residual Template Tokens |
| `persona_vocabulary_compliance` | Persona vocabulary compliance | Persona is missing from the backlog persona inventory or the project-defined persona glossary | User story contract (backlog-owned); Personas |
| `feature_pbi_persona_alignment` | Feature <-> PBI persona alignment | PBI persona is not present in the parent Feature `affectedPersonas` list | Feature structure; PBI user stories and structure |
| `user_story_pbi_traceability` | User story <-> PBI traceability | A user story has no grounded PBI, or a PBI has no user story trace | User story contract (backlog-owned); PBI user stories and structure |
| `scope_traceability` | PRD scope traceability | Backlog item is not grounded in the PRD narrative | Feature structure; PBI user stories and structure |
| `out_of_scope_alignment` | Out-of-scope alignment | PRD exclusions contradict backlog scope | Proposed Solution; Feature structure |
| `target_surface_alignment` | Target surface alignment | PRD surface label conflicts with described backlog behavior | Target Surface; PBI user stories and structure |
| `nfr_consistency` | Non-functional requirements consistency | PRD NFRs contradict backlog delivery expectations or fields | Non-Functional Requirements; PBI user stories and structure |
| `business_rule_traceability` | Business rule traceability | `BR-NNN` reference is orphaned or never enforced downstream | Business Rules; PBI user stories and structure |
| `ac_scenario_coverage` | Acceptance-criteria scenario coverage | PBI is missing required scenario rows such as happy path, validation, authorization, or failure handling | Acceptance Criteria coverage |
| `depends_on_dag_validity` | dependsOn DAG validity | `dependsOn` contains a cycle, self-edge, or dangling reference | dependsOn graph validity |
| `dependency_locality` | Dependency locality | Item-level `dependsOn` crosses the owning Feature boundary | dependsOn graph validity |
| `implementation_phase_coverage` | Implementation-phase coverage | An Epic is missing from `implementationPhases`, or phase ordering contradicts dependencies | Implementation Phases |
| `feature_flag_alignment` | Feature-flag alignment | PRD flag intent conflicts with backlog flag usage | Feature Flag; Feature structure |
| `terminology_consistency` | Project terminology consistency | A non-canonical project or domain term is used where a glossary-defined term exists | Project Terminology Consistency |
