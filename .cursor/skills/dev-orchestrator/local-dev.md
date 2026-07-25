# Local Development Mode

Read this file when Feature Executor runs from a **local kickoff prompt** (Cursor session, not Dev Workbench). Apply these overrides before Phase F0.

## Artifact root resolution

| Source | Canonical path |
|--------|---------------|
| Dev Workbench | `.ai-pilot/output/{slug}.backlog.json` |
| **Local kickoff** | **`.ai-pilot/local-dev/{slug}/{slug}.backlog.json`** (and `{slug}.test-cases.json`, `{slug}-design-spec/…`) |

Use the root advertised in the kickoff prompt. If files are absent at either path, stop and ask the operator where the context pack was placed.

When reading F0 paths in [feature-executor.md](feature-executor.md), substitute `.ai-pilot/local-dev/{slug}/` for `.ai-pilot/output/` whenever the kickoff specifies a local artifact root.

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
