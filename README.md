# Apex

Apex is an internal product-building and project-management platform. It centralizes AI-guided design interviews, automated PRD and design-doc generation, review workflows, daily standups, planning analytics, Azure DevOps integration, feature request triage, and cloud cost tracking into a single React + Express + PostgreSQL application.

**Core idea:** one place for delivery work — work items, documents, ceremonies, and analytics — with AI agents that automate repetitive steps and keep outputs consistent.

For a full product overview, see [`context.md`](./context.md). For agent and contributor orientation, see [`AGENTS.md`](./AGENTS.md).

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
- PostgreSQL 14+ (only if you run a local database; skip if your shared env points at a cloud/dev DB)
- Shared local env files from the team (preferred) — or values to fill `.env` yourself
- Azure DevOps access / PAT with Work Items (Read, Write) permissions
- Azure AD app registration configured for local sign-in (redirect: `http://localhost:3001/auth/callback`)
- Docker Desktop (required to build/run the load-test k6 runner image locally; not required for day-to-day `npm run dev`)

### Windows developer tooling (Chocolatey)

Use [Chocolatey](https://chocolatey.org/) to install the host tools Apex developers commonly need. Run the installers in an **elevated** PowerShell.

#### 1. Install Chocolatey (once)

```powershell
# Run as Administrator
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
choco --version
```

#### 2. Install project dependencies

```powershell
# --- Core: local app (API + Vite UI + Jest) ---
choco install nodejs --version=24.0.0 -y
# Or latest Node from Chocolatey; confirm `node -v` is >= 24:
#   choco install nodejs -y

choco install git -y
choco install postgresql16 -y          # local DB option; skip if you use a shared/cloud DATABASE_URL

# --- Optional but common ---
choco install azure-cli -y             # Azure AD/ACR/Key Vault/Service Bus auth from the host
choco install terraform -y             # work under infra/ (fmt/validate/plan)

# --- Load-test runner (FEAT-008) ---
choco install docker-desktop -y        # required to `docker build` / run runners/load-test-k6
choco install k6 -y                    # optional: host k6 without the Docker image

# --- E2E (Playwright browsers are installed via npm, not Chocolatey) ---
# After npm install:
#   npm run playwright:install
```

After **Docker Desktop** installs, reboot if prompted, start Docker Desktop, and wait until it is running. On Windows, enable the **WSL2** engine if `docker version` fails (`wsl --install` / `wsl --update` as Administrator, then Docker Desktop → Settings → General).

#### 3. Verify

```powershell
node -v                  # >= v24
npm -v
git --version
psql --version           # if you installed local Postgres
az version               # if you installed Azure CLI
terraform version        # if you installed Terraform
docker version           # if you will build the load-test runner
k6 version               # optional host k6
```

| Tool | Chocolatey package | Needed for |
|------|--------------------|------------|
| Node.js 24+ | `nodejs` | `npm install`, `npm run dev`, Jest, builds |
| Git | `git` | Clone / commits |
| PostgreSQL 14+ | `postgresql16` (or similar) | Local `DATABASE_URL` / `aipilot` DB |
| Azure CLI | `azure-cli` | Optional cloud auth from the host |
| Terraform | `terraform` | Optional `infra/` work |
| Docker Desktop | `docker-desktop` | Load-test k6 runner image (`runners/load-test-k6`) |
| k6 | `k6` | Optional host smoke without Docker |

Playwright Chromium is **not** a Chocolatey package — after `npm install`, run `npm run playwright:install` when you need e2e.

## First-run checklist

1. Clone and `npm install`
2. Place the shared `.env` (and `.env.local` if provided) in the repo root — **do not commit them**
3. Ensure Postgres is reachable (`DATABASE_URL` in the shared env, or create a local `aipilot` DB)
4. Apply migrations (`npm run migrate:local:up` or `npm run migrate:up`, depending on which env file holds `DATABASE_URL`)
5. `npm run dev` → open `http://localhost:3000` and sign in with Azure AD
6. Smoke-check: home loads, you can open a project view, ADO-backed data appears when configured

Optional for AI agent flows: `CURSOR_API_KEY` and Bedrock vars must be present in the shared env (see [`.env.example`](./.env.example)).

## Setup

### 1. Clone and install

```bash
git clone https://github.com/ryamiller-amergis/Apex.git
cd Apex
npm install
```

### 2. Environment

**Preferred:** request the team's shared local env files and place them at the repo root as `.env` (and `.env.local` if your team splits DB settings). Never commit `.env`, `.env.local`, or other credential files.

**Alternative:** copy the example and fill values yourself:

```bash
cp .env.example .env
```

Minimum variables for a working local app:


| Variable | Purpose |
| -------- | ------- |
| `ADO_ORG` / `ADO_PROJECT` / `ADO_PAT` | Azure DevOps connection |
| `ADO_AREA_PATH` | Optional area-path filter |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | Azure AD sign-in |
| `AZURE_REDIRECT_URL` | Usually `http://localhost:3001/auth/callback` for local |
| `SESSION_SECRET` | Express session secret |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | API server port (default `3001`) |
| `POLL_INTERVAL` | ADO poll interval in seconds (default `30`) |
| `CURSOR_API_KEY` | Cursor agents / Ask Apex (optional for basic UI smoke) |
| `AWS_REGION` / `BEDROCK_MODEL_ID` | Bedrock models (optional; when using Bedrock) |
| `BACKLOG_AGENT_SIGNING_SECRET` | HMAC secret for agent callbacks (required in production) |

Auth setup details: [`docs/AUTHENTICATION_SETUP.md`](./docs/AUTHENTICATION_SETUP.md).

See [`.env.example`](./.env.example) for the full list, including Application Insights, SendGrid, and MaxView MCP options.

### 3. Database

Apex uses PostgreSQL with SQL migrations in `migrations/`. `aipilot` is the conventional database name used in local examples, CI, and Terraform — not a separate service.

**Option A — local Postgres**

```bash
# Use your local Postgres superuser (often `postgres` or `pgadmin`)
createdb -U postgres aipilot
# or in psql: CREATE DATABASE aipilot;
```

Point `DATABASE_URL` at that database (in `.env` or git-ignored `.env.local`):

```bash
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/aipilot
```

Apply migrations (when `DATABASE_URL` is in `.env.local`):

```bash
npm run migrate:local:up
```

**Option B — shared / cloud (or tunnel) database**

If the shared env already has a working `DATABASE_URL` (Azure PostgreSQL or a tunnel), skip `createdb` and apply migrations against that URL:

```bash
npm run migrate:up
```

#### Migration commands


| Command                                  | What it does                                                          |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `npm run migrate:local:create -- <name>` | Scaffold a new `.sql` migration                                       |
| `npm run migrate:local:up`               | Apply pending migrations using `.env.local`                           |
| `npm run migrate:local:down`             | Roll back the last migration using `.env.local`                       |
| `npm run migrate:up`                     | Apply pending migrations using `DATABASE_URL` from `.env`             |
| `npm run migrate:down`                   | Roll back the last migration on that target                           |


Always develop and verify migrations locally first when possible, then apply to shared/cloud when ready. In production, migrations run as part of the CI/CD deploy pipeline before the app starts.

### 4. Run

```bash
npm run dev
```

Starts the Express API (default port `3001`) and the Vite frontend (default port `3000`). Sign in via Azure AD when prompted.

### Day-to-day commands

```bash
npm run dev          # local API + frontend
npm test             # Jest
npm run lint         # Prettier check
npm run lint:check   # ESLint (client)
npm run format       # Prettier write
npm run changelog    # helper for release notes
npm run build && npm start   # production-style build/run
```

A Husky **pre-commit** hook runs:

1. ESLint via `lint-staged` on staged `src/{client,server,shared}/**/*.{ts,tsx}` files only (untouched files are skipped). Warnings and errors both fail the commit (`--max-warnings=0`). Fix with `npm run lint:fix` or address findings manually, then re-stage.
2. A **data-testid** policy (`scripts/check-data-testid.mjs`) on staged client TSX under `src/client/` (excludes tests). When a file is staged, **every** interactive element in that file must include a `data-testid` (or `anchorTestIdProps`) — not only newly added lines. Covered: `button`, `input`, `select`, `textarea`, `a`, `form`, `dialog`, elements with click/submit handlers, and common `*Button` / `*Modal` / … components. Escape hatch: `// data-testid-exempt` on the line above the tag. In Cursor: `/resolve-pre-commit-data-testid` or `/resolve-pre-commit-eslint` for the matching hook failure.

Pull requests opened in GitHub use the description template in [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md). In Cursor, developers can kick off a filled PR with the [`create-pull-request`](./.cursor/skills/create-pull-request/SKILL.md) skill (`/create-pull-request`).

Where to look while developing:

- [`context.md`](./context.md) — product overview and workflows
- [`AGENTS.md`](./AGENTS.md) — feature map, key services/components
- [`design-docs/`](./design-docs/) — design decisions for major features
- [`docs/`](./docs/) — auth, security, cost, release process

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


| Doc | Use it for |
| --- | ---------- |
| [`context.md`](./context.md) | Product overview, workflows, modules, admin capabilities |
| [`AGENTS.md`](./AGENTS.md) | Feature map, key services/components, agent guidelines |
| [`design-docs/`](./design-docs/) | Design decisions behind major features |
| [`docs/AUTHENTICATION_SETUP.md`](./docs/AUTHENTICATION_SETUP.md) | Azure AD app registration and local callback setup |
| [`public/CHANGELOG.json`](./public/CHANGELOG.json) | What shipped, newest first |
| [`.cursor/skills/`](./.cursor/skills/) | Procedures for interviews, PRDs, standups, flags, etc. |


## Security notes

- ADO PAT and other secrets stay on the server; the frontend talks only to Apex APIs.
- Prefer short-lived agent signing secrets in production (`BACKLOG_AGENT_SIGNING_SECRET`).
- Do not commit `.env`, `.env.local`, or credential files.
