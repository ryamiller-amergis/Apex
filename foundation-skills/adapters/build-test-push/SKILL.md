---
name: build-test-push
description: Project adapter for build-test-push. Customize for your project.
---

# build-test-push — Project Adapter

<!-- Managed loader: loads .apex/foundation/build-test-push/SKILL.md -->

- Project: {{slot:projectName}}
- Build: `npm run build` (or project's equivalent build command)
- Type-check server: `npx tsc -p tsconfig.server.json --noEmit` (if applicable)
- Type-check client: `npx tsc -p tsconfig.client.json --noEmit` (if applicable)
- Lint: `npm run lint:check` (or project's equivalent)
- Tests: `npm test` (or project's equivalent)
- Validate foundation: `node scripts/validate-foundation-skills.mjs` (if present)
