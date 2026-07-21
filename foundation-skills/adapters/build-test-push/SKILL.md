---
name: build-test-push
description: APEX adapter for build-test-push. Binds to APEX's npm scripts and tsconfig targets.
---

# build-test-push — APEX Adapter

<!-- Managed loader: loads .apex/foundation/build-test-push/SKILL.md -->

- Project: {{slot:projectName}}
- Build: `npm run build` (runs `build:server` then `build:client`)
- Type-check server: `npx tsc -p tsconfig.server.json --noEmit`
- Type-check client: `npx tsc -p tsconfig.client.json --noEmit`
- Lint: `npm run lint:check`
- Tests: `npm test`
- Validate foundation: `node scripts/validate-foundation-skills.mjs`
