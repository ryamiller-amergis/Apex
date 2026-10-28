# Common failures

## Purpose

Name the install and startup failures this template prints, and the change that clears each one. The messages below are the ones the tools print. Match the text, then apply the fix.

## Prerequisites

- A checkout of this repository.
- The command was run from the repository root.

## Steps

Find the message in the sections below and apply that fix. Then repeat the command that failed.

### Frozen install is out of date

A catalog change prints `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` and names the catalog. Other manifest drift prints `ERR_PNPM_OUTDATED_LOCKFILE`. Neither command changes `pnpm-lock.yaml`. Run `pnpm install`, review the lockfile diff, and commit `pnpm-lock.yaml`.

### The package manager is not pnpm

The guard prints:

```text
check-toolchain: this workspace uses pnpm. Run "corepack enable", then "pnpm install --frozen-lockfile" from the workspace root.
```

Enable Corepack, then repeat the frozen install. Do not use `npm install`. The guard deletes `package-lock.json` if npm already wrote one, and it does not leave `node_modules`.

### pnpm is not the pinned version

pnpm prints `ERR_PNPM_UNSUPPORTED_ENGINE` and the expected version `10.34.9` before it fetches packages. Run `corepack enable`, or invoke `corepack pnpm`, so Corepack selects pnpm `10.34.9`. When the guard itself runs, it prints:

```text
check-toolchain: pnpm <actual> does not match the pinned pnpm 10.34.9 (packageManager in package.json). Run "corepack enable" and retry.
```

`<actual>` is the pnpm version that started the command.

### Node is outside the 24 line

pnpm prints `ERR_PNPM_UNSUPPORTED_ENGINE`, the expected range `>=24.0.0 <25.0.0`, and the running version. Nothing is installed. Install `24.22.1` from `.nvmrc`, or any other Node 24 patch. When the guard itself runs, it prints:

```text
check-toolchain: Node <actual> is outside the supported range >=24.0.0 <25.0.0 (engines.node in package.json). Install the version in .nvmrc and retry.
```

### The API stops before it listens

`apps/api/src/config/env.ts` checks every variable, prints one block, and exits 1. The block starts with `Invalid environment configuration` and ends with `See .env.example for every variable.` Each line names a variable. A secret reads `value hidden`. The received value is never printed. Fix `.env` so it matches `.env.example`, then start again.

Two identity failures stop startup the same way, before the port opens:

- `Invalid environment: AUTH_MODE=development is not allowed when NODE_ENV=production.`
- `AUTH_MODE=external requires an adapter registered in apps/api/src/identity/registry.ts.`

`AUTH_MODE` has no default. Set `development` for local work. `development` is refused when `NODE_ENV` is `production`. `external` needs an adapter in that registry file; none ships with the template.

`FEATURE_FLAGS` is different. An invalid value does not stop startup. The API logs `feature_flags.config_invalid` without the value, and every flag returns its default.

### The port is already in use

Docker Compose reports the failure when `POSTGRES_PORT` is taken. Change `POSTGRES_PORT` and the port inside `DATABASE_URL` together. Node's env-file loader does not expand variables, so the two values must be equal.

When the API cannot bind, it logs `server.listen_failed` and `the API could not open its port`, then exits 1. The log names the error code and not the environment values. Pick a free `PORT`.

### Docker is not available

`pnpm db:up` cannot start PostgreSQL. `pnpm test:integration` and `pnpm test:e2e` exit with the Docker message. `pnpm test` skips those suites and prints the reason. Unit, component, API, and contract tests do not need Docker.

## Verify

Repeat the command that failed. A fixed install ends with a completed `pnpm install`. A fixed start logs `listening`.

## Troubleshooting

If the message is not in this runbook, read the command's own output. It names the file or variable at fault. Schema mismatches are in [migrations](migrations.md). Scan and image failures are in [supply chain](supply-chain.md).
