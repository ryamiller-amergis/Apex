Implement the following work item locally in this repository.

Title: My Work Cloud Development (Cursor Cloud Agents) — Host-Agnostic Work-Item Integrate
ID: feature FEAT-006 (PRD 07329ad8-bc34-4b2d-a161-ef664fa586f5)
Type: Apex Feature

Context files have been extracted under `.ai-pilot/local-dev/feat-006/`. Read them before coding:

- `.ai-pilot/local-dev/feat-006/prd.md`
- `.ai-pilot/local-dev/feat-006/backlog.json`
- `.ai-pilot/local-dev/feat-006/design-spec/design.md`
- `.ai-pilot/local-dev/feat-006/design-spec/tech-spec.md`
- `.ai-pilot/local-dev/feat-006/design-spec/assumptions.md`

## Development skill

This project is configured to use the `/.cursor/skills/dev-orchestrator/SKILL.md` skill. Begin by invoking:

  //.cursor/skills/dev-orchestrator/SKILL.md feature feat-006 FEAT-006

### Local execution policy (overrides Dev Workbench defaults)

- **Artifact root:** `.ai-pilot/local-dev/feat-006/` (not `.ai-pilot/output/`)
- **Git:** local Cursor session — do NOT run `git commit` or `git push` unless explicitly asked.
- **E2E tests:** author required Playwright specs where acceptance criteria require them; defer *execution* only when a Playwright environment is unavailable.
- **Assumption gate:** stop and resolve any ⚠ unresolved items in `design-spec/assumptions.md` that affect behavior, security, or scope before writing code.
- **Naming:** verify all file/key names against the live repository before implementing.
- **Stubs:** thin permission-gated route stubs are acceptable for routes that downstream features will replace.
- **Protected files** (require explicit permission): `src/server/index.ts`, `package.json`, `tsconfig*.json`, `vite.config.ts`, `jest.config.*`, any CI/CD files.