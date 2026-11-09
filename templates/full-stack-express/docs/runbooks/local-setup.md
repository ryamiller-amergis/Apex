# Local setup

## Purpose

Get from a clean checkout to a running web client and API, with PostgreSQL, applied migrations, and synthetic seed data.

## Prerequisites

- Node 24. The patch in `.nvmrc` is `24.22.1`. Any patch on the 24 line passes the guard. Node 25 and later do not bundle Corepack.
- Docker, for local PostgreSQL. The API still type-checks and its unit tests still run without it.
- A shell in the repository root, the directory that contains `package.json`.

## Steps

1. Enable Corepack so it selects the pnpm version in `package.json`.

   ```sh
   corepack enable
   ```

   If that cannot write to the Node install directory, leave the shims unchanged and prefix later commands with `corepack`, for example `corepack pnpm install --frozen-lockfile`. Root scripts that call pnpm already go through Corepack.

2. Install the locked dependencies. The install is frozen: it refuses to change `pnpm-lock.yaml`.

   ```sh
   pnpm install --frozen-lockfile
   ```

   `pnpm setup` runs that same command.

3. Copy the example environment file.

   ```sh
   cp .env.example .env
   ```

   On Windows PowerShell, use `Copy-Item .env.example .env`.

4. Start PostgreSQL with Docker Compose and wait until it accepts connections.

   ```sh
   pnpm db:up
   ```

   `pnpm db:down` stops it. The data volume stays.

5. Create the tables, then load synthetic rows.

   ```sh
   pnpm migrate
   pnpm seed
   ```

   Both read `NODE_ENV` and `DATABASE_URL` from `.env`. The API never changes the schema when it starts.

6. Run the API and the web client.

   ```sh
   pnpm dev
   ```

The API reads `.env` when that file exists. A missing or invalid value stops the API before it listens and names every bad variable. The message never prints a value.

## Verify

- `pnpm toolchain:check` exits 0.
- `pnpm migrate` prints `Applied 1 migration: 0000_init_app_users` on the first run, or `No pending migrations.` after that, and exits 0.
- `pnpm seed` prints a `Seeded` line and exits 0.
- The web client and the API are both running after `pnpm dev`. The API log line says `listening`.

## Troubleshooting

Install and startup failures, including a lockfile mismatch and a Corepack version mismatch, are in [common failures](common-failures.md). Schema commands are in [migrations](migrations.md).
