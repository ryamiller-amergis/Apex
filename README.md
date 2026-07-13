# Apex

Apex is an internal product-building and project-management platform. It centralizes AI-guided design interviews, automated PRD and design-doc generation, review workflows, daily standups, planning analytics, Azure DevOps integration, feature request triage, and cloud cost tracking into a single React + Express + PostgreSQL application.

**Core idea:** one place for delivery work — work items, documents, ceremonies, and analytics — with AI agents that automate repetitive steps and keep outputs consistent.

For a full product overview, see `[context.md](./context.md)`. For agent and contributor orientation, see `[AGENTS.md](./AGENTS.md)`.

## Tech Stack


| Layer        | Technologies                                                                           |
| ------------ | -------------------------------------------------------------------------------------- |
| Frontend     | React 18, TypeScript, Vite, React Router, TanStack Query, CSS Modules                  |
| Backend      | Express, TypeScript, Drizzle ORM, node-pg-migrate                                      |
| Data         | PostgreSQL 14+                                                                         |
| Integrations | Azure DevOps, Cursor SDK, AWS Bedrock, Microsoft Teams Bot, Azure Application Insights |
| Auth         | Azure AD (Passport / MSAL)                                                             |


## Prerequisites

- Node.js 24+
- PostgreSQL 14+
- Azure DevOps Personal Access Token (PAT) with Work Items (Read, Write) permissions
- Azure AD app registration (for sign-in in full environments)

## Setup

### 1. Clone and install

```bash
git clone <repository-url>
cd AI-Pilot
npm install
```

### 2. Environment

```bash
cp .env.example .env
```

Minimum local values to set in `.env` (and/or `.env.local` for the database):


| Variable                          | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `ADO_ORG`                         | Azure DevOps organization URL                            |
| `ADO_PROJECT`                     | Default ADO project name                                 |
| `ADO_PAT`                         | Personal Access Token                                    |
| `ADO_AREA_PATH`                   | Optional area-path filter                                |
| `PORT`                            | API server port (default `3001`)                         |
| `POLL_INTERVAL`                   | ADO poll interval in seconds (default `30`)              |
| `DATABASE_URL`                    | PostgreSQL connection string                             |
| `AWS_REGION` / `BEDROCK_MODEL_ID` | Bedrock region and default model (when using Bedrock)    |
| `BACKLOG_AGENT_SIGNING_SECRET`    | HMAC secret for agent callbacks (required in production) |


See `[.env.example](./.env.example)` for the full list, including Application Insights, SendGrid, and MaxView MCP options.

### 3. Database

Apex uses PostgreSQL with SQL migrations in `migrations/`. There are two common targets: a **local** database for development and a **cloud** database (Azure PostgreSQL) pointed to by `DATABASE_URL` in `.env`.

#### First-time local database

```bash
createdb -U pgadmin aipilot
# or in psql: CREATE DATABASE aipilot;
```

Create `.env.local` (git-ignored):

```bash
DATABASE_URL=postgresql://pgadmin:yourpassword@localhost:5432/aipilot
```

Apply migrations:

```bash
npm run migrate:local:up
```

#### Migration commands


| Command                                  | What it does                                                          |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `npm run migrate:local:create -- <name>` | Scaffold a new `.sql` migration                                       |
| `npm run migrate:local:up`               | Apply pending migrations to local DB                                  |
| `npm run migrate:local:down`             | Roll back the last local migration                                    |
| `npm run migrate:up`                     | Apply pending migrations using `DATABASE_URL` from `.env` (cloud/dev) |
| `npm run migrate:down`                   | Roll back the last migration on that target                           |


Always develop and verify migrations locally first, then apply to cloud when ready. In production, migrations run as part of the CI/CD deploy pipeline before the app starts.

### 4. Run

```bash
npm run dev
```

Starts the Express API (default port `3001`) and the Vite frontend (default port `3000`).

### Build and start (production)

```bash
npm run build
npm start
```

### Test and lint

```bash
npm test
npm run lint
npm run lint:check
```

## Project layout

```
src/
├── client/                 # React frontend (Vite)
│   ├── components/         # UI views and shared components
│   ├── hooks/              # TanStack Query hooks and feature hooks
│   ├── contexts/           # React contexts (e.g. notifications)
│   ├── config/             # Client config (models, release, env)
│   ├── services/           # Client-side helpers (e.g. telemetry)
│   ├── utils/              # Pure client utilities
│   ├── types/              # Client-only types
│   ├── App.tsx             # Root routing
│   └── main.tsx            # App entry
├── server/                 # Express backend
│   ├── routes/             # HTTP route handlers
│   ├── services/           # Business logic (60+ services)
│   ├── middleware/         # Auth, RBAC, error handling
│   ├── db/                 # Drizzle ORM setup and schema
│   ├── mcp/                # Hosted MCP proxies (ADO, GitHub, MaxView)
│   ├── workers/            # Background workers (e.g. PDF export)
│   ├── skills/             # Server-bundled skill definitions
│   ├── utils/              # Server utilities (SSE, sanitizers, etc.)
│   └── index.ts            # Server entry
└── shared/                 # Code shared by client and server
    ├── types/              # Shared TypeScript types
    ├── config/             # Shared config (e.g. context limits)
    ├── constants/          # Shared constants
    └── utils/              # Shared helpers
.cursor/
├── skills/                 # Agent skill definitions (SKILL.md workflows)
├── rules/                  # Coding and governance rules for agents
└── plans/                  # Working plans
.github/workflows/          # CI/CD (PR tests, deploy)
design-docs/                # Feature design documents and plans
docs/                       # Setup and ops docs (auth, security, cost, releases)
infra/                      # Terraform for Azure (App Service, Postgres, etc.)
migrations/                 # SQL migrations (node-pg-migrate)
public/                     # Static assets, branding, CHANGELOG.json
scripts/                    # Dev/CI helper scripts
teams-app/                  # Microsoft Teams app package (manifest + icons)
context.md                  # Product knowledge base
AGENTS.md                   # Agent / contributor quick reference
```

## Architecture (short)

- **Frontend** — React SPA with code-split views, TanStack Query for server state, and CSS custom properties for theming (Light / Dark / Amergis).
- **Backend** — Express API; business logic lives in `src/server/services/`. Work item traffic to Azure DevOps is proxied through the server so credentials stay server-side.
- **Persistence** — PostgreSQL for users, RBAC, interviews, PRDs, design docs, standups, notifications, feature flags, and project settings. Azure DevOps remains the system of record for work items.
- **AI** — Cursor SDK agents and optional AWS Bedrock models, driven by per-project skill and model settings. Real-time UX uses SSE for notifications and streamed chat.

## Documentation


| Doc                                                | Use it for                                               |
| -------------------------------------------------- | -------------------------------------------------------- |
| `[context.md](./context.md)`                       | Product overview, workflows, modules, admin capabilities |
| `[AGENTS.md](./AGENTS.md)`                         | Feature map, key services/components, agent guidelines   |
| `[design-docs/](./design-docs/)`                   | Design decisions behind major features                   |
| `[public/CHANGELOG.json](./public/CHANGELOG.json)` | What shipped, newest first                               |
| `[.cursor/skills/](./.cursor/skills/)`             | Procedures for interviews, PRDs, standups, flags, etc.   |


## Security notes

- ADO PAT and other secrets stay on the server; the frontend talks only to Apex APIs.
- Prefer short-lived agent signing secrets in production (`BACKLOG_AGENT_SIGNING_SECRET`).
- Do not commit `.env`, `.env.local`, or credential files.

## License

MIT