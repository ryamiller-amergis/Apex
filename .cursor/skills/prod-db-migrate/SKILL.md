---
name: prod-db-migrate
description: Opens a temporary Azure Postgres firewall rule, fetches prod DATABASE_URL from App Service, lists pending migrations, and runs node-pg-migrate against production. Use when applying a migration to production, running migrate:up on prod, seeding prod data via SQL migrations, or when the user asks to add a temporary firewall and execute a migration against the production database.
---

# Production DB Migrate

Apply pending `migrations/*.sql` files to Apex **production** Postgres from a developer machine. Prod blocks public access, so this flow always opens a **temporary** firewall rule for the current public IP, then deletes it.

## When to use

- User asks to run a migration against production
- User asks to open a temp Postgres firewall and execute SQL / migrate:up on prod
- Seeding production rows via a migration file (e.g. ADRs)

Do **not** use for local or cloud-dev DBs — use `.cursor/skills/postgresql-migrations/SKILL.md` instead.

## Prerequisites

1. `az login` into the production subscription (`MSS-Production`)
2. Permissions to:
   - create/delete firewall rules on `psql-apex-eus2`
   - read App Service app settings on `app-apex-prd`
3. Run commands from the **repo root**
4. Explicit user request before applying (prod write)

## Resource defaults

| Resource | Value |
|----------|--------|
| Subscription | `MSS-Production` |
| Postgres | `psql-apex-eus2` in `rg-apex-prd-data` |
| App (DATABASE_URL) | `app-apex-prd` in `rg-apex-prd-app` |

Defined in `scripts/prod-db-defaults.ps1`.

## Scripts (execute these — do not reinvent)

All under `.cursor/skills/prod-db-migrate/scripts/`:

| Script | Purpose |
|--------|---------|
| `prod-db-defaults.ps1` | Shared constants + `Get-ApexProdDatabaseUrl` (never prints the URL) |
| `open-temp-firewall.ps1` | Create firewall rule for current public IP |
| `close-temp-firewall.ps1` | Delete that rule (`-RuleName` required) |
| `list-pending-migrations.js` | Compare `migrations/` to `pgmigrations` |
| `apply-named-migration.js` | Apply **one** `migrations/<name>.sql` + insert `pgmigrations` (out of order OK with `--no-check-order`) |
| `verify-query.js` | Read-only SQL check (`$1`… params) |
| `apply-prod-migrations.ps1` | **Orchestrator**: open → fetch URL → list → migrate → optional verify → close |

## Standard workflow

### Preferred — full orchestrator

On this team's Windows machines use `powershell` (PowerShell 5). Use `pwsh` only if PowerShell 7+ is installed.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/apply-prod-migrations.ps1
```

Dry-run (firewall + list only):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/apply-prod-migrations.ps1 -DryRun
```

Apply only the next N pending migrations (lexicographic order):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/apply-prod-migrations.ps1 -Count 1
```

Apply **one named file** when other pending migrations should wait (typical for prod seeds):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/apply-prod-migrations.ps1 `
  -NamedMigration 20260730200000_seed-production-grounded-checkout-interviews-adr `
  -VerifySql "SELECT id, title, status, slug FROM adrs WHERE id = `$1" `
  -VerifyArgs @('8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72')
```

Apply all pending + verify a seed row:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/apply-prod-migrations.ps1 `
  -VerifySql "SELECT id, title, status, slug FROM adrs WHERE id = `$1" `
  -VerifyArgs @('8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72')
```

### Manual steps (same scripts)

```powershell
$rule = "temp-cursor-migrate-$($env:USERNAME.ToLower())"
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/open-temp-firewall.ps1 -RuleName $rule

. .cursor/skills/prod-db-migrate/scripts/prod-db-defaults.ps1
$env:DATABASE_URL = Get-ApexProdDatabaseUrl
$env:PROD_DATABASE_URL = $env:DATABASE_URL

node .cursor/skills/prod-db-migrate/scripts/list-pending-migrations.js
npm run migrate:up

# optional verify
node .cursor/skills/prod-db-migrate/scripts/verify-query.js `
  "SELECT id, title, status FROM adrs WHERE id = `$1" `
  8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72

powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/prod-db-migrate/scripts/close-temp-firewall.ps1 -RuleName $rule
Remove-Item Env:DATABASE_URL, Env:PROD_DATABASE_URL -ErrorAction SilentlyContinue
```

## Agent rules

1. **Always** open the firewall before connecting; **always** delete it in a `finally`-equivalent path (even on failure).
2. **Never** print, commit, or log `DATABASE_URL` / passwords.
3. Before applying, run `list-pending-migrations.js`. If more than the requested file would apply via `migrate:up`, either confirm with the user or use `-NamedMigration <name>` / `-Count N`.
4. Prefer the orchestrator script over ad-hoc `az` / `node -e` one-liners.
5. SSL: prod clients in these scripts use `rejectUnauthorized: false` (same as hung-interview diagnose). Do not change App Service SSL settings.
6. Do not modify `package.json`, `vite.config.ts`, or other scope-restricted config for this workflow.
7. Creating the SQL file itself still follows `.cursor/skills/postgresql-migrations/SKILL.md` (`next-migration-timestamp.mjs`, etc.).

## Safety

- Temp firewall rule names should start with `temp-cursor-migrate-` so they are obvious to delete.
- `migrate:up` uses `--no-check-order` (project default).
- Seed migrations that `RAISE EXCEPTION` when required users are missing will fail fast — fix data or abort; do not weaken the SQL.
- If Azure CLI is on the wrong subscription, `az account set --subscription MSS-Production` first.

## Related

- Local / cloud-dev migrations: `.cursor/skills/postgresql-migrations/SKILL.md`
- Prod interview diagnostics (same firewall pattern): `.cursor/skills/hung-interview-troubleshoot/SKILL.md`
