---
name: adr-finalize
description: Silently converts an ADR interview transcript into a consistent MADR-style Architecture Decision Record. Use when generating the final ADR artifact from a completed ADR conversation.
disable-model-invocation: true
---

# ADR Finalize

Generate one Architecture Decision Record without asking questions.

## Inputs

1. Read `.ai-pilot/kickoff-transcript.md` as the authoritative decision input.
2. Read [adr-template.md](adr-template.md) and follow it exactly.
3. Inspect referenced repository files only when needed to verify names or links. Do not invent evidence.

## Output

1. Derive a concise kebab-case slug from the decision title.
2. Write exactly one file: `.ai-pilot/output/{slug}.adr.md`.
3. Use the fixed section order and headings from `adr-template.md`.
4. Set frontmatter:
   - `adr-number`: use a known number, otherwise `ADR-pending`
   - `status`: `Proposed`, unless the transcript explicitly authorizes `Accepted` or `Superseded`
   - `date`: current date in `YYYY-MM-DD`
   - `slug`: the output slug
5. Include at least two considered options when the transcript supports them. Never manufacture an option merely to reach a count.
6. State both positive and negative consequences. Preserve unresolved risks explicitly.
7. Keep references traceable to repository paths, design documents, work items, or external sources present in the transcript.
8. When the decision adopts or rejects shared Blob/Service Bus topology, cite `.cursor/skills/azure-async-infra/SKILL.md` and `infra/shared-async.tf` in References.
9. When the decision implies Terraform delivery under `infra/`, cite `.cursor/skills/terraform-infra/SKILL.md` and the expected `*.tf` ownership in References.## Quality check

Before finishing, verify the file has valid YAML frontmatter and every template section. The title, selected option, drivers, and consequences must agree. Do not respond with the ADR content in chat; the file is the deliverable.
