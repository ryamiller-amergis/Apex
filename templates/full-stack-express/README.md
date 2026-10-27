# project-name

Self-contained pnpm workspace for a React web client and an Express API. It has its own lockfile, toolchain, and lint rules. It does not join the host repository's install, build, or test commands.

Run every command in this README from `templates/full-stack-express/` while this folder sits inside the Apex repository. Do not run `pnpm install` from the Apex root. That writes a lockfile beside the host project and breaks this workspace's isolation. After the folder is copied into its own repository, run the same commands from the directory that contains this README.

Node 25 and later do not bundle Corepack. This workspace stays on the Node 24 line, which does bundle it. On Node 25 or later, install Corepack with `npm install -g corepack` before `corepack enable`.

## Clean checkout

1. Install Node 24. The patch in `.nvmrc` is 24.22.1. The guard accepts any patch on the 24 line, then enable Corepack.
   Working directory: `templates/full-stack-express/`.

   ```sh
   corepack enable
   ```

   If that command cannot write to the Node install directory, leave the shims unchanged and prefix later commands with `corepack`. For example, `corepack pnpm install --frozen-lockfile`. Root scripts that call pnpm already go through Corepack.

2. Install the locked dependencies. The install is frozen: it refuses to change the lockfile.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm install --frozen-lockfile
   ```

3. Build all five workspace members. The web client and the API write separate `dist/` directories.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm build
   ```

4. Type-check every member. Run this after the build. The contracts and UI packages are imported from `dist/`.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm typecheck
   ```

5. Lint every member from the workspace root.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm lint
   ```

6. Check formatting.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm format:check
   ```

7. Check the pinned toolchain, the compatibility table, dependency specs, and shared TypeScript config.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm toolchain:check
   ```

8. Run the workspace tests. Run this after the build.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm test
   ```

9. Run the static checks together.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm check
   ```

## Local stack

Copy the example environment file, install, start PostgreSQL, then start the API and the web client.
Working directory: `templates/full-stack-express/`.

```sh
cp .env.example .env
pnpm setup
pnpm db:up
pnpm dev
```

On Windows PowerShell, copy the file with `Copy-Item .env.example .env`.

`pnpm db:up` starts PostgreSQL and waits until it accepts connections. `pnpm db:down` stops it. The data volume stays. `pnpm dev` runs the API and the web client. The API reads `.env` when that file exists. A missing or invalid value stops the API before it listens and names every bad variable. The message never prints a value.

`pnpm migrate` and `pnpm seed` are the names Platform Engineering's pipeline calls. Starter Persistence replaces their bodies. Until then each command prints `Provided by the Starter Persistence feature` and exits 1.

## Change the PostgreSQL port

Docker Compose reports the failure when the host port is already in use. Node's env-file loader does not expand variables, so change both of these in `.env` and keep them equal:

- `POSTGRES_PORT`
- the port inside `DATABASE_URL`

`DATABASE_URL` in the example file uses port `5432`, the same value as `POSTGRES_PORT`. The database is published on `127.0.0.1` only.

To format files, run `pnpm format` from `templates/full-stack-express/`.

## Scripts

| Script            | What it does                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `preinstall`      | Runs the toolchain guard before any dependency is fetched                                         |
| `setup`           | Installs from the lockfile. This is the install step                                              |
| `build`           | Builds members in dependency order through Corepack. The config package has no build              |
| `check`           | Runs typecheck, lint, and format:check                                                            |
| `typecheck`       | Type-checks every member that defines the script                                                  |
| `lint`            | Lints the whole workspace once                                                                    |
| `format`          | Rewrites files with Prettier                                                                      |
| `format:check`    | Fails when a file disagrees with Prettier                                                         |
| `test`            | Runs member tests, then the toolchain guard tests                                                 |
| `dev`             | Runs the API and the web client with file watching. This is the local run step                    |
| `migrate`         | Applies migrations. Starter Persistence replaces the body; until then the command exits 1         |
| `seed`            | Loads synthetic local data. Starter Persistence replaces the body; until then the command exits 1 |
| `db:up`           | Starts local PostgreSQL and waits until it is healthy                                             |
| `db:down`         | Stops local PostgreSQL. The data volume stays                                                     |
| `toolchain:check` | Compares the catalog, the compatibility table, manifests, and `tsconfig.json` extends             |

The web and API builds do not read each other's output.

Build the API and the packages it depends on.
Working directory: `templates/full-stack-express/`.

```sh
pnpm --filter @project-scope/api... build
```

Build the web client and the packages it depends on.
Working directory: `templates/full-stack-express/`.

```sh
pnpm --filter @project-scope/web... build
```

The first command writes `apps/api/dist` and `packages/contracts/dist`. The second writes `apps/web/dist`, `packages/ui/dist`, and `packages/contracts/dist`.

## Package source

Packages download from the public npm registry. That registry is not the git remote where a new product repository will live. `.npmrc` has no registry URL and no token. A product that uses a private feed adds the feed URL locally and reads the token from the environment. Do not commit the token.

## Replacement placeholders

Search for each token and replace it by hand. There is no generator. The workspace builds before any token is replaced.

| Token             | Meaning                              | Occurs in                                                                                  |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `project-name`    | Human-readable name                  | Root `package.json` description, README                                                    |
| `@project-scope`  | npm scope of every workspace package | All `package.json` names, `workspace:*` dependencies, TypeScript `extends`, source imports |
| `project-service` | Service name                         | README. Later environment and observability settings                                       |
| `project_db`      | Database name                        | README, `compose.yaml`, `.env.example`. Later migrations                                   |

## When a command fails

The frozen install is out of date. A catalog change prints `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` and names the catalog. Other manifest drift prints `ERR_PNPM_OUTDATED_LOCKFILE`. Neither command changes the lockfile. From `templates/full-stack-express/`, run `pnpm install`, review the lockfile diff, and commit `pnpm-lock.yaml`.

```text
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH
```

The package manager is not pnpm. The guard prints:

```text
check-toolchain: this workspace uses pnpm. Run "corepack enable", then "pnpm install --frozen-lockfile" from the workspace root.
```

Enable Corepack, then repeat the frozen install from `templates/full-stack-express/`. Do not use `npm install`. The guard deletes `package-lock.json` if npm already wrote one, and it does not leave `node_modules`.

The pnpm version does not match `packageManager`. pnpm prints `ERR_PNPM_UNSUPPORTED_ENGINE` and the expected version `10.34.9` before it fetches packages. Run `corepack enable`, or invoke `corepack pnpm`, so Corepack selects pnpm 10.34.9, then retry from `templates/full-stack-express/`. When the guard itself runs, it prints:

```text
check-toolchain: pnpm <actual> does not match the pinned pnpm 10.34.9 (packageManager in package.json). Run "corepack enable" and retry.
```

`<actual>` is the pnpm version that started the command.

Node is outside the 24 line. pnpm prints `ERR_PNPM_UNSUPPORTED_ENGINE`, the expected range `>=24.0.0 <25.0.0`, and the running version. Nothing is installed. Install 24.22.1 from `.nvmrc`, or any other Node 24 patch, and retry. When the guard itself runs, it prints:

```text
check-toolchain: Node <actual> is outside the supported range >=24.0.0 <25.0.0 (engines.node in package.json). Install the version in .nvmrc and retry.
```

`<actual>` is the running Node version.
