Implement the following work item locally in this repository.

Title: Create ats skill — ATS Discovery Interview Skill
ID: feature FEAT-001 (PRD f4a0a7db-750d-4b13-9f7c-b7b3ca677517)
Type: Apex Feature

Context files have been extracted under `.ai-pilot/local-dev/feat-001/`. Read them before coding:

- `.ai-pilot/local-dev/feat-001/prd.md`
- `.ai-pilot/local-dev/feat-001/backlog.json`
- `.ai-pilot/local-dev/feat-001/design-spec/design.md`
- `.ai-pilot/local-dev/feat-001/design-spec/tech-spec.md`
- `.ai-pilot/local-dev/feat-001/design-spec/assumptions.md`

## Development skill

This project is configured to use the `/.cursor/skills/dev-orchestrator/SKILL.md` skill.

Begin by invoking:

  /dev-orchestrator feature feat-001 FEAT-001

### Local execution policy (overrides Dev Workbench defaults)

- **Artifact root:** `.ai-pilot/local-dev/feat-001/` (not `.ai-pilot/output/`)
- **Git:** local Cursor session — do NOT run `git commit` or `git push` unless explicitly asked.
- **E2E tests:** author required Playwright specs where acceptance criteria require them; defer *execution* only when a Playwright environment is unavailable.
- **Assumption gate:** stop and resolve any ⚠ unresolved items in `design-spec/assumptions.md` that affect behavior, security, or scope before writing code.
- **Naming:** verify all file/key names against the live repository before implementing.
- **Stubs:** thin permission-gated route stubs are acceptable for routes that downstream features will replace.
- **Protected files** (require explicit permission): `src/server/index.ts`, `package.json`, `tsconfig*.json`, `vite.config.ts`, `jest.config.*`, any CI/CD files.