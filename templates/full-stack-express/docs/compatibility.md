# Compatibility

Pinned versions for this workspace. The source is the newest stable release on
the implementation date, except where a peer dependency forces the previous
major. `toolchain:check` fails when this table and `pnpm-workspace.yaml` disagree.

| Component                 | Pinned version | Source                                            | Installed in                                                         |
| ------------------------- | -------------- | ------------------------------------------------- | -------------------------------------------------------------------- |
| Node                      | 24.22.1        | implementation-date latest stable                 | .nvmrc                                                               |
| pnpm                      | 10.34.9        | implementation-date latest peer-compatible stable | packageManager                                                       |
| typescript                | 6.0.3          | implementation-date latest peer-compatible stable | apps/api, apps/web, packages/contracts, packages/ui                  |
| eslint                    | 9.39.5         | implementation-date latest peer-compatible stable | package root, packages/config                                        |
| @eslint/js                | 9.39.5         | implementation-date latest stable                 | packages/config                                                      |
| typescript-eslint         | 8.72.1         | implementation-date latest stable                 | packages/config                                                      |
| eslint-plugin-react-hooks | 7.1.1          | implementation-date latest stable                 | packages/config                                                      |
| eslint-plugin-jsx-a11y    | 6.10.2         | implementation-date latest stable                 | packages/config                                                      |
| globals                   | 17.13.0        | implementation-date latest stable                 | packages/config                                                      |
| prettier                  | 3.9.10         | implementation-date latest stable                 | package root, apps/api                                               |
| vitest                    | 5.0.5          | implementation-date latest stable                 | apps/api, apps/web, packages/config, packages/contracts, packages/ui |
| vite                      | 8.3.5          | implementation-date latest stable                 | apps/web                                                             |
| @vitejs/plugin-react      | 6.1.2          | implementation-date latest stable                 | apps/web                                                             |
| react                     | 19.3.1         | implementation-date latest stable                 | apps/web                                                             |
| react-dom                 | 19.3.1         | implementation-date latest stable                 | apps/web                                                             |
| @types/react              | 19.3.0         | implementation-date latest stable                 | apps/web                                                             |
| @types/react-dom          | 19.3.0         | implementation-date latest stable                 | apps/web                                                             |
| @types/node               | 24.19.2        | implementation-date latest stable                 | apps/api, apps/web                                                   |
| express                   | 5.3.0          | implementation-date latest stable                 | reserved                                                             |
| @mui/material             | 9.5.0          | implementation-date latest stable                 | reserved                                                             |
| drizzle-orm               | 0.45.4         | implementation-date latest stable                 | apps/api                                                             |
| drizzle-kit               | 0.31.11        | implementation-date latest stable                 | apps/api                                                             |
| pg                        | 8.23.1         | implementation-date latest stable                 | apps/api                                                             |
| @types/pg                 | 8.23.1         | implementation-date latest stable                 | apps/api                                                             |
| @playwright/test          | 1.64.1         | implementation-date latest stable                 | reserved                                                             |
| @testing-library/react    | 16.3.3         | implementation-date latest stable                 | reserved                                                             |
| testcontainers            | 12.2.1         | implementation-date latest stable                 | apps/api                                                             |
| yaml                      | 2.9.1          | implementation-date latest stable                 | packages/config                                                      |
| zod                       | 4.6.7          | implementation-date latest stable                 | apps/api, apps/web                                                   |

## Selection notes

- Node `24.22.1` is the newest Node 24 patch on 2026-10-26. `.nvmrc` records that patch. `engines.node` is `>=24.0.0 <25.0.0`, so another patch on the 24 line passes the guard.
- pnpm `12.15.0` is newer and ships a native executable. pnpm 11 and later start that executable, which Windows group policy blocks on the implementation machine. This workspace pins pnpm `10.34.9`, the newest release that still runs on Node. Corepack checks the hash stored in `packageManager`. Root scripts that recurse call `corepack pnpm` so a different pnpm on `PATH` cannot satisfy them. `corepack enable` needs write access to the Node install directory. When that write is refused, prefix the documented commands with `corepack`.
- TypeScript `7.0.2` is newer. `typescript-eslint` `8.72.1` accepts TypeScript below `6.1.0`, so this workspace pins TypeScript `6.0.3`.
- ESLint `10.13.0` is newer. `eslint-plugin-jsx-a11y` `6.10.2` accepts ESLint through version 9, so this workspace pins ESLint `9.39.5`.
- Rows marked `reserved` are reviewed now and installed by the feature that first imports them. They are absent from the lockfile until then.
- `onlyBuiltDependencies` is empty. pnpm skips dependency lifecycle scripts unless a package is listed there. Add a package only after it needs a build step, and record the reason in this file.
- On pnpm 10.34.9, `engine-strict=true` rejects a Node or pnpm version outside `engines` before dependencies are fetched and before `preinstall`. The install exits with `ERR_PNPM_UNSUPPORTED_ENGINE`, names the expected range and the running version, and does not create `node_modules`. Checked on 2026-10-26 with `engines.node` set to `>=99.0.0 <100.0.0`. The `preinstall` guard still rejects `npm install`, and `pnpm toolchain:check` runs the same script for the catalog and the table.
- A frozen install after a catalog edit fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` and leaves `pnpm-lock.yaml` unchanged. The guard's own messages are unchanged.
- `.npmrc` does not set `package-lock=false`. pnpm treats that key as "do not use a lockfile" and then refuses a frozen install. npm still writes `package-lock.json` before `preinstall` returns, so the guard deletes that file when the package manager is not pnpm.
- zod `4.6.7` is the newest Zod 4 release on 2026-10-26. Apex allows `zod ^4.3.6`. This workspace pins the exact release. Schema messages are static strings, so a later Zod 4 release cannot start printing received values.
- yaml `2.9.1` parses `compose.yaml` in the configuration tests.
- Local PostgreSQL uses the image `postgres:16`, the same major version Apex CI runs. The tag is pinned in `compose.yaml`. This table mirrors the pnpm catalog, and the toolchain check rejects a row the catalog does not have, so the image tag is not a catalog row.

## Registry

Dependencies install from the public npm registry. This file records versions, not a git remote. Do not commit a registry token. A consuming repository that uses a private feed adds the feed URL in `.npmrc` and reads the token from the environment.
