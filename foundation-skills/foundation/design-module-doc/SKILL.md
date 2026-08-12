---
name: design-module-doc
description: Generates a source-grounded module architecture document with consistent Markdown and Mermaid sections. Use when generating an architecture document for a specific codebase module.
metadata:
  apex-disable-model-invocation: "true"
---

# Design Module Documentation — Foundation

Generate one source-grounded, principal-engineer-level architecture document from only the source globs provided. The result must be concise enough to scan, but substantive enough to support implementation, incident response, and design review.

## Procedure

1. Read every existing file matched by the allowed source globs (provided in kickoff context).
2. Do not read or rely on implementation files outside those globs.
3. Trace actual entry points, client calls, route handlers and middleware, service calls, agent or worker execution, workspace files, persistence, external systems, and deployment boundaries.
4. Identify asynchronous transitions, polling/watchers, event fan-out, ownership or leasing, retries, timeouts, cleanup, and startup recovery present in source.
5. Identify authentication, authorization, tenant/project, resource-ownership, secret, and network boundaries present in source.
6. Use only file names, APIs, tables, files, paths, statuses, and relationships verified in the matched source.
7. Write the final document to `.ai-pilot/output/design-module.md`.
8. Do not create any other output file.

## Required output sections (in this order)

````markdown
## Purpose and Scope
[Two to four concise paragraphs defining responsibilities, included and excluded behavior, architectural drivers, and authoritative state.]

## Architecture Diagram
```mermaid
flowchart TD
[Trace real relationships from source]
```

## Key Files
| File | Role |
[List only files verified in source]

## Data Flow
[Numbered steps tracing a primary request or event through the module]

## Security Boundaries
[Auth, authorization, and data access boundaries from source]

## Failure Modes
[Error paths, retries, timeouts, and recovery from source]
````

Do not invent components, APIs, or relationships not present in the source files.
