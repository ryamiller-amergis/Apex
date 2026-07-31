# Local Development Mode

Read this file when Feature Executor runs from a **local kickoff prompt** (Cursor session, not Dev Workbench). Apply these overrides before Phase F0.

## Artifact root resolution

| Source | Canonical path |
|--------|---------------|
| Dev Workbench | `.ai-pilot/output/{slug}.backlog.json` |
| **Local kickoff** | **`.ai-pilot/local-dev/{pack}/backlog.json`** (see short layout below) |

`{pack}` is a short id from the kickoff (`feat-001`, `wi-12345`, …) — **not** the long PRD title slug.

Use the root advertised in the kickoff prompt. If files are absent at either path, stop and ask the operator where the context pack was placed.

When reading F0 paths in [feature-executor.md](feature-executor.md), substitute `.ai-pilot/local-dev/{pack}/` for `.ai-pilot/output/` whenever the kickoff specifies a local artifact root.

## Local pack file names (short — required)

Local packs use **fixed short names** (no `{slug}` / feature-title prefixes). Map F0 paths as follows:

| Feature Executor (Dev Workbench) | Local kickoff |
|----------------------------------|---------------|
| `{root}/{slug}.backlog.json` | `{root}/backlog.json` |
| `{root}/{slug}.prd.md` | `{root}/prd.md` |
| `{root}/{slug}.test-cases.json` | `{root}/test-cases.json` |
| `{root}/{slug}-design-spec/{feature-slug}-design.md` | `{root}/design-spec/design.md` |
| `{root}/{slug}-design-spec/{feature-slug}-tech-spec.md` | `{root}/design-spec/tech-spec.md` |
| `{root}/{slug}-design-spec/{feature-slug}-assumptions.md` | `{root}/design-spec/assumptions.md` |
| `{root}/{slug}-design-spec/{feature-slug}-prototype.html` | `{root}/design-spec/prototype.html` |
| (ADO) `{root}/work-item.md` | `{root}/work-item.md` |

## Git policy

Do **not** run `git commit` or `git push`. The operator drives version control manually. Do not reference `finalisePush` or branch creation — those are Dev Workbench concerns only.

## Scope discipline

These files require **explicit operator permission** before modification:

- `src/server/index.ts`
- `package.json`
- `tsconfig*.json`
- `vite.config.ts`
- `jest.config.*`
- Any CI/CD files (`.github/`, `azure-pipelines.yml`, etc.)

## Context Block git line

In Phase F1, set:

```
Git policy: NO `git commit` / NO `git push`. Local Cursor session — operator owns version control.
```
