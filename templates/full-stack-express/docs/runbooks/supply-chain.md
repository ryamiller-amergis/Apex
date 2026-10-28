# Supply chain and the production image

Run these commands from the template root. They are local scripts. They are
not quality-manifest gates. `container:build` is the gate name a manifest
should cite. Secret scan, vulnerability scan, license check, and SBOM
generation stay scripts a pipeline can call.

The organization has not confirmed this tool list. The versions below are the
spec defaults, pinned in `docs/compatibility.md`.

| Check           | Tool                                                                               | Script                 |
| --------------- | ---------------------------------------------------------------------------------- | ---------------------- |
| Secrets         | secretlint 13.1.0                                                                  | `pnpm scan:secrets`    |
| Vulnerabilities | OSV-Scanner 2.7.0                                                                  | `pnpm scan:vulns`      |
| Licenses        | `pnpm licenses list --prod`                                                        | `pnpm scan:licenses`   |
| All three       | The scripts above                                                                  | `pnpm scan`            |
| SBOM            | CycloneDX from the production graph; image contents use `@cyclonedx/cdxgen` 12.9.0 | `pnpm sbom`            |
| Image           | Docker, Node 24 bookworm-slim pinned by digest                                     | `pnpm container:build` |

`pnpm scan` runs all three checks and prints every finding. Exit `0` means
nothing to fix. Exit `1` means findings. Exit `2` means the check could not
run. A check that cannot run is not a pass. The combined script uses the
highest code.

## Secrets

`pnpm scan:secrets` reads tracked files in this directory. It prints the rule,
file, and line. It does not print the matched value. A planted value used by
the tests is created when the test runs. Do not commit one.

`config/supply-chain/secret-scan.ignore` skips tracked test files. Those files
hold synthetic database URLs. Passing a file list to the scanner still scans
those paths. The documented local URL in `.env.example` is allowed by
`config/supply-chain/.secretlintrc.json`. Any other database URL is a finding.

## Vulnerabilities

`pnpm scan:vulns` reads `pnpm-lock.yaml` with OSV-Scanner. The script downloads
the pinned binary into `node_modules/.cache` on first use and checks its
checksum. High and critical advisories fail the scan. A score of 7.0 or higher
is high. A score of 9.0 or higher is critical. Moderate and low advisories are
reported only by the scanner's own data and do not fail this script.

The first run needs network access to fetch the scanner and the advisory data.
If that source cannot be reached, the script exits `2`.

## Record a reviewed exception

Add one object to `config/supply-chain/vulnerability-exceptions.json`. An empty
array means there are no exceptions. Each object needs all of these fields:

| Field      | Meaning                                             |
| ---------- | --------------------------------------------------- |
| `advisory` | The advisory id, such as a GHSA id                  |
| `package`  | The package name the advisory applies to            |
| `reason`   | Why the team is accepting it                        |
| `owner`    | The person who reviewed it                          |
| `reviewed` | The review date, `YYYY-MM-DD`                       |
| `expires`  | The last day the exception is honored, `YYYY-MM-DD` |

An exception on or before `expires` is honored. The scan prints
`honored exception: <advisory> <package>`. After that date the finding fails
the scan and the output says the exception expired. A file that omits a field
exits `2` and names the file and the field.

## Licenses

`pnpm scan:licenses` checks production dependencies against
`config/supply-chain/allowed-licenses.json`. A license id that is not on the
list is printed with the package name and the script exits `1`. An `OR`
expression passes when one side is allowed. An `AND` expression passes when
every id is allowed.

## SBOM

`pnpm sbom` writes `artifacts/sbom/project-service.cdx.json`. The file is
CycloneDX 1.6. It lists the production dependencies of `@project-scope/api`
and `@project-scope/web`, including transitive packages, and omits development
dependencies. The component list is sorted. The serial number comes from the
lockfile hash. The document has no timestamp unless `SOURCE_DATE_EPOCH` is
set. Two runs with the same lockfile produce the same bytes.

The write is atomic: a temporary file is renamed into place and removed if the
write fails. `artifacts/` is gitignored and listed in `.dockerignore`.

`pnpm sbom -- --image <tag>` writes `artifacts/sbom/project-service.image.cdx.json`
from the image contents with `@cyclonedx/cdxgen`. That mode needs Docker. The
lockfile mode does not.

## Production image

`pnpm container:build` builds `project-service:local` from the `Dockerfile` in
this directory. The image copies production dependencies with
`pnpm deploy --legacy --prod`. pnpm 10 otherwise requires injected workspace
packages, and this template keeps workspace links as they are. The runtime
listens on port `3000` unless `PORT` is set. The
image sets only:

| Variable          | Value        |
| ----------------- | ------------ |
| `NODE_ENV`        | `production` |
| `CLIENT_DIST_DIR` | `/app/web`   |

It does not set `PORT`, `DATABASE_URL`, or `AUTH_MODE`. Those names, and the
telemetry names, are the ones the API already reads. Do not invent a second
set. The process is user `10001`. The runtime image has no npm, npx, corepack,
yarn, or development dependencies. It does not run migrations and it does not
contain the SQL files. Apply migrations with `pnpm migrate` from a checkout
before traffic moves.

Start the image with the variables from `.env.example`. `NODE_ENV=production`
rejects `AUTH_MODE=development` before the port opens. `AUTH_MODE=external`
also stops startup until an adapter is registered in
`apps/api/src/identity/registry.ts`. A local smoke test overrides
`NODE_ENV=development` and sets `AUTH_MODE=development`. The image is the same
either way.

The image health check calls `GET /health/live` so a database outage does not
mark the container unhealthy. Readiness is `GET /health/ready`.

`pnpm test:container` runs the image probes. If Docker is not available, that
script exits `2` and names Docker. The unit tests still cover each criterion
without Docker.

A read-only run needs a writable `/tmp`:

```sh
docker run --rm --read-only --cap-drop ALL --tmpfs /tmp \
  -e NODE_ENV=development \
  -e AUTH_MODE=development \
  -e DATABASE_URL=postgresql://app_user:local-dev-only-password@postgres:5432/project_db \
  -p 3000:3000 \
  project-service:local
```

Pass production values as environment variables at run time. Do not bake them
into the image.
