-- Point the seeded pdf-assembly Design Module at leftover Apex files after
-- PDF tools moved to DocHub. Interactive editing is no longer in this repo.

-- Up Migration
UPDATE design_modules
SET
  description = 'Orphan Apex PDF session schema after the DocHub split. Interactive PDF tools live in the standalone DocHub app.',
  source_globs = '[
    "src/server/utils/dataDir.ts",
    "src/server/db/schema.ts",
    "src/shared/types/pdf.ts",
    "migrations/1782890000000_create-pdf-sessions.sql",
    "migrations/20260711011000_pdf-conversion-jobs.sql",
    "infra/README.md"
  ]'::jsonb,
  source_fingerprint = NULL,
  source_commit = NULL,
  documentation = $pdf$
## Purpose and Scope

Interactive PDF assembly, Nutrient, and Apryse viewers were removed from Apex and now live in the standalone DocHub app. This module covers only leftover Apex artifacts: Drizzle types for orphan `pdf_sessions` / job tables, historical migrations, and shared Blob notes for `pdf-artifacts`.

Do not treat this module as a live product surface. Apex no longer hosts `/pdf-tools`, `/api/pdf`, or `pdf-assembly:use`.

## System and Component Architecture

```mermaid
flowchart LR
  subgraph Apex["Apex leftover"]
    Schema["pdf_sessions JSONB schema"]
    Types["shared types/pdf.ts"]
    Blob["pdf-artifacts container kept"]
  end
  subgraph DocHub["DocHub app"]
    Web["Nutrient Web SDK"]
    Node["Nutrient Node SDK"]
  end
  Schema -.-> Types
  Blob -.-> Schema
  Web --> Node
```

## Runtime Sequence and Data Flow

```mermaid
sequenceDiagram
  participant User
  participant Apex as Apex app
  participant DocHub as DocHub app
  User->>Apex: no PDF workbench route
  User->>DocHub: Entra login and open workbench
  DocHub->>DocHub: convert or export via Node SDK
```

## Persistence and State Model

- Historical `pdf_sessions` and conversion-job tables remain in Apex Postgres (orphan data; not dropped in this change).
- `src/shared/types/pdf.ts` still types those JSONB columns for Drizzle.
- Shared Blob still lists `pdf-artifacts` so Terraform apply does not destroy existing blobs.

## Key Files and Layers

| Layer | File | Responsibility |
|---|---|---|
| Types | `src/shared/types/pdf.ts` | JSONB contracts for leftover PDF tables. |
| Schema | `src/server/db/schema.ts` | Orphan `pdf_sessions` / job table definitions. |
| Data root | `src/server/utils/dataDir.ts` | Shared data-directory resolution (not PDF-specific). |
| History | `migrations/1782890000000_create-pdf-sessions.sql` | Original session tables. |
| Infra | `infra/README.md` | Documents keeping `pdf-artifacts` for now. |

## Detailed Runtime Flow

1. Apex no longer mounts PDF routes or starts a PDF processing poller.
2. Existing session/job rows stay until a later cleanup migration.
3. Operators use DocHub for conversion and editing.

## Reliability, Failure, and Recovery

- Apex startup recovery no longer expires PDF sessions.
- DocHub uses file sessions on a single App Service instance; that runtime is outside this repository.

## Security and Operational Boundaries

- `pdf-assembly:use` is removed from the Apex permission catalog.
- DocHub authenticates with Entra independently of Apex RBAC.

## Related Docs

- `infra/README.md`
- `public/CHANGELOG.json` (1.37.0)
  $pdf$,
  updated_at = now()
WHERE slug = 'pdf-assembly';

-- Down Migration
-- Restore prior source_globs from 20260715224500 (deleted Apex PDF files).
UPDATE design_modules
SET
  description = 'Document upload, conversion, page assembly, and PDF export.',
  source_globs = '[
    "src/client/components/PdfAssemblyView.tsx",
    "src/client/components/AssemblyLane.tsx",
    "src/client/components/PageThumbnail.tsx",
    "src/server/routes/pdf.ts",
    "src/server/services/pdfAssemblyService.ts",
    "src/server/services/pdfConversionJobService.ts",
    "src/server/services/documentConversionService.ts",
    "src/server/services/documentConversionWorker.ts",
    "src/server/workers/pdfExportWorker.ts",
    "src/server/utils/dataDir.ts",
    "src/server/db/schema.ts",
    "src/shared/types/pdf.ts",
    "migrations/1782890000000_create-pdf-sessions.sql",
    "migrations/20260711011000_pdf-conversion-jobs.sql",
    "infra/README.md"
  ]'::jsonb,
  source_fingerprint = NULL,
  source_commit = NULL,
  updated_at = now()
WHERE slug = 'pdf-assembly';
