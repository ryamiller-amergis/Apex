Implement the following work item locally in this repository.

Title: My Work Cloud Development (Cursor Cloud Agents) — Remaining Work Loop-Back to My Work
ID: feature FEAT-005 (PRD 07329ad8-bc34-4b2d-a161-ef664fa586f5)
Type: Apex Feature

Context files have been extracted under `.ai-pilot/local-dev/feat-005/`. Read them before coding:

- `.ai-pilot/local-dev/feat-005/prd.md`
- `.ai-pilot/local-dev/feat-005/backlog.json`
- `.ai-pilot/local-dev/feat-005/design-spec/design.md`
- `.ai-pilot/local-dev/feat-005/design-spec/tech-spec.md`
- `.ai-pilot/local-dev/feat-005/design-spec/assumptions.md`

## Development skill

This project is configured to use the `/.cursor/skills/dev-orchestrator/SKILL.md` skill. Begin by invoking:

  //.cursor/skills/dev-orchestrator/SKILL.md feature feat-005 FEAT-005

### Local execution policy (overrides Dev Workbench defaults)

- **Artifact root:** `.ai-pilot/local-dev/feat-005/` (not `.ai-pilot/output/`)
- **Git:** local Cursor session — do NOT run `git commit` or `git push` unless explicitly asked.
- **E2E tests:** author required Playwright specs where acceptance criteria require them; defer *execution* only when a Playwright environment is unavailable.
- **Assumption gate:** stop and resolve any ⚠ unresolved items in `design-spec/assumptions.md` that affect behavior, security, or scope before writing code.
- **Naming:** verify all file/key names against the live repository before implementing.
- **Stubs:** thin permission-gated route stubs are acceptable for routes that downstream features will replace.
- **Protected files** (require explicit permission): `src/server/index.ts`, `package.json`, `tsconfig*.json`, `vite.config.ts`, `jest.config.*`, any CI/CD files.