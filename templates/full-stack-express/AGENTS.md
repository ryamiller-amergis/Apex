# Agent guide

Read this file first. It links every document in the repository and the plain-text [agent index](docs/agent-index.txt). Every document is Markdown or text, so you can read it without installing or running anything.

## Start here

1. Read the [architecture overview](docs/architecture.md) for how the web client, the API, the contracts, and the database fit together.
2. Find the workspace member you will change in the [module map](docs/module-map.md). It names each member's responsibility and public interface.
3. Set up a local stack with the [local setup runbook](docs/runbooks/local-setup.md).
4. Before you open a pull request, run the checks in the [testing guide](docs/testing.md) and `pnpm docs:check`.

Rules that hold everywhere:

- Run commands from the repository root. Use pnpm through Corepack. Never use npm or yarn.
- An API route is defined once, in Zod, in `packages/contracts/`. Do not edit `packages/contracts/openapi/openapi.json` by hand. Regenerate it.
- The API never changes the database schema when it starts. Schema changes ship as committed migrations.
- The template defines no roles or permissions. Every route under `/api/v1` needs an authenticated principal and nothing more.
- Use synthetic values in code, tests, and documents: `example.test` email addresses and invented names. Never paste a secret, a real person's name, or an internal host name.

## Documentation map

| Document                                                                                 | Read it when                                                           |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [README](README.md)                                                                      | You need the command reference, environment variables, or placeholders |
| [Architecture overview](docs/architecture.md)                                            | You need the big picture: layers, request flow, data, identity         |
| [Module map](docs/module-map.md)                                                         | You need to know which member owns a behavior and what it exports      |
| [Feature slices](docs/feature-slices.md)                                                 | You add a product area and need the profile files to copy              |
| [Build artifacts](docs/plans/README.md)                                                  | You run a prompted build and need the brief, plan, and question text   |
| [API documentation](docs/api.md)                                                         | You call, change, or add an HTTP endpoint                              |
| [Testing guide](docs/testing.md)                                                         | You write tests or need to know which suite and gate covers a change   |
| [Design-system reference](docs/design-system.md)                                         | You style a screen, change a token, or brand the app                   |
| [Component catalog](docs/component-catalog.md)                                           | You need a shared component, its props, or its test ids                |
| [Compatibility table](docs/compatibility.md)                                             | You add or upgrade a dependency or the toolchain                       |
| [Architecture decision records](docs/adr/README.md)                                      | You want to know why a decision was made, or you record a new one      |
| [ADR template](docs/adr/0000-template.md)                                                | You write a new decision record                                        |
| [ADR 0001: Zod contracts](docs/adr/0001-zod-contracts-are-the-api-authority.md)          | You wonder why routes start in `packages/contracts/`                   |
| [ADR 0002: No roles](docs/adr/0002-no-roles-or-permissions-in-the-template.md)           | You need authorization and wonder where it attaches                    |
| [ADR 0003: Forward-only migrations](docs/adr/0003-forward-only-production-migrations.md) | You plan a rollback that touches the schema                            |
| [ADR 0004: Docs as code](docs/adr/0004-docs-as-code-knowledge-base.md)                   | You wonder why documents live here and how they stay accurate          |
| [Local setup runbook](docs/runbooks/local-setup.md)                                      | You start from a clean checkout                                        |
| [Migrations runbook](docs/runbooks/migrations.md)                                        | You change the schema or apply migrations                              |
| [Common failures runbook](docs/runbooks/common-failures.md)                              | Install, startup, or a command fails                                   |
| [Supply-chain runbook](docs/runbooks/supply-chain.md)                                    | You run the scans, write an SBOM, or build the production image        |
| [Platform Engineering handoff](docs/handoff.md)                                          | You review adoption: ownership, pipeline contracts, open decisions     |
| [Agent index](docs/agent-index.txt)                                                      | You want every document as one plain-text list                         |

Member guides with more detail:

- [API routes, errors, and probes](apps/api/README.md)
- [Identity adapters](apps/api/src/identity/README.md)
- [Contract conventions](packages/contracts/README.md)
- [UI package usage](packages/ui/README.md)
- [Quality and NFR manifests](quality/README.md)
- [Evidence reports](quality/evidence/README.md)

## Skills

Skills are step-by-step instructions an agent loads for one kind of task. Each skill is one folder under `.cursor/skills/` holding a `SKILL.md` file.

When you add a skill, link its `SKILL.md` from this section and add its path to the [agent index](docs/agent-index.txt). `pnpm docs:check` reports a skill that is missing from either place.

- [Orchestrator](.cursor/skills/orchestrator/SKILL.md) — run a prompted build, ask the recorded questions, and show the integration verdict
- [API contract](.cursor/skills/api-contract/SKILL.md) — adding or changing an HTTP endpoint
- [UI standards](.cursor/skills/ui-standards/SKILL.md) — adding or changing a screen
- [Planner](.cursor/skills/planner/SKILL.md) — turn a prompt into a plan from the module map and the manifests
- [UI role](.cursor/skills/ui/SKILL.md) — build a screen from the design system and record evidence
- [Developer](.cursor/skills/developer/SKILL.md) — implement a task with the required standards and gates
- [QA](.cursor/skills/qa/SKILL.md) — report evidence for every quality gate
- [Integration](.cursor/skills/integration/SKILL.md) — decide whether a build is ready for a pipeline

## Scripts

Run these from the repository root. The full list is in the [README script table](README.md#scripts).

| Script                  | What it does                                                                     |
| ----------------------- | -------------------------------------------------------------------------------- |
| `pnpm setup`            | Installs from the lockfile                                                       |
| `pnpm dev`              | Runs the API and the web client with file watching                               |
| `pnpm build`            | Builds every workspace member                                                    |
| `pnpm check`            | Runs typecheck, lint, format:check, openapi:check, and routes:check              |
| `pnpm test`             | Runs the test suites. Suites that need Docker or Chromium skip and say why       |
| `pnpm docs:check`       | Reports broken links, missing sections, stale paths, and index gaps in documents |
| `pnpm quality:validate` | Checks the quality and NFR manifests                                             |
| `pnpm openapi:generate` | Rewrites the committed OpenAPI document from the route definitions               |
| `pnpm migrate`          | Applies pending migrations                                                       |
| `pnpm toolchain:check`  | Compares the catalog, the compatibility table, and the pinned toolchain          |

### How `pnpm docs:check` reads documents

The check covers `AGENTS.md`, `README.md`, every Markdown file under `docs/`, and every `SKILL.md` under `.cursor/skills/`. Its settings are in `docs/docs-check.config.json`. It exits 0 when it finds nothing, 1 when it finds problems, and 2 when the settings, the entry point, or the index cannot be used. Each problem is one line: the rule, the document and line, then the link target, path, heading, or term.

- It recognizes `#` headings and inline links only. Underlined headings and HTML anchors are ignored.
- It never opens an external link. It does not check the `#section` part of an internal link.
- An inline code span that looks like a repository path must exist. Fenced code blocks are skipped. To keep an example path that does not exist, put `<!-- docs-check-exempt -->` on the same line or the line above.
- A new document must be added to the agent index and linked from this file.
