# Repo grounding consolidation

Architectural plan to serve AI repository reads from a single bare object
database at a pinned SHA, instead of materialized working trees. Status:
Stages 0–2 implemented in-process (flag `repo-read-service` default off).
Stages 3–6 follow after the in-process reader is proven in a project.

## Why

Six storage locations, ~4,300 lines across ten services, and six feature flags
exist because reads are served from working trees that must be created, shared,
refreshed, protected, and evicted. `git cat-file` / `git ls-tree` / `git grep`
against a bare mirror at a pinned SHA remove that category.

In-flight runs stay pinned. Fetch is append-only, so it cannot disturb a pin.
Resume policy: stay pinned, ask at the resume boundary. Handoff policy: inherit
the parent's SHA, offer "use latest" at generate.

## Stage map

| Stage | Contents |
|-------|----------|
| 0 | Alternates `--dissociate`, per-repo (not per-branch) mirrors, bounded user-facing lease waits, webhook spike, baseline metrics |
| 1 | Pin refs, in-process `BareRepoReader`, `repo-read-service` flag |
| 2 | Pin lifetime independent of idle `closeThread`; remove between-turn auto-advance |
| 3 | Extract to a Container App (HTTP read API; ephemeral disk + Blob restore) |
| 4 | Webhook or `ls-remote` adaptive refresh |
| 5 | Resume card, handoff dialog, staleness rendering, artifact provenance |
| 6 | Retire working-tree stack and six superseded flags |

## Stage 0 findings

- Workers do not call `git` directly, but `LocalCheckoutReader.searchCode`
  runs `git grep` inside the checkout. Native-read search on Container Apps
  therefore depends on a self-contained tree. `--reference` without
  `--dissociate` is a live bug.
- There is no GitHub or Azure DevOps push webhook receiver in this repo.
  Stage 4 stays poll-based until a public callback + GitHub App / ADO service
  hook is confirmed. Spike: Platform Admin / network policy + GitHub MCP.
- Baseline gates already defined in `groundingGateService.ts`: fallback-rate
  &lt; 2%, warm p95 &lt; 10s, cold p95 &lt; 60s, mirror-hit-rate &gt; 90%. Capture
  current Application Insights values before Stage 3.

## Out of scope

Dev workbench and foundation-skill updates stay on App Service
`dev-workspaces/` writable clones. Do not mix read and write in this pass.
