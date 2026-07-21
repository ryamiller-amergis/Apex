---
name: fullstack-node-bff
description: Best practices for full-stack TypeScript architecture with an Express Backend-for-Frontend serving a React/Vite SPA. Use when adding API routes, client-side data fetching, shared types, environment variables, or when the user asks about code organization in a Node BFF project.
disable-model-invocation: true
---

# Fullstack Node BFF — Foundation

Single TypeScript monorepo: Express serves both the API and the React SPA from one Node process.

## Standard project layout

```
src/
  server/       — Express API (Node.js)
    routes/     — Express routers mounted in entry point
    services/   — Business logic (never import from client/)
    middleware/ — Auth, error handling
    db/         — Database access layer
  client/       — React + Vite (ESM)
    hooks/      — Data-fetching hooks
    services/   — fetch() wrappers
    components/ — React components
    config/     — Environment config
  shared/       — Types/utils imported by BOTH server AND client
    types/      — TypeScript interfaces
    utils/      — Pure functions (no platform-specific imports)
```

## Rules

### Client API calls always use relative paths

```typescript
// Good — works in dev (proxied) and production (same-origin)
const response = await fetch('/api/workitems', { credentials: 'include' });

// Bad — breaks in production
const response = await fetch('http://localhost:3001/api/workitems');
```

### Never import server code from the client

```typescript
// Bad — drags server deps into the Vite bundle
import { db } from '../../server/db/drizzle';

// Good — communicate via HTTP; share types via src/shared/
import type { WorkItem } from '../../shared/types/workitem';
```

### Always pass credentials

Client fetches must include `credentials: 'include'` to send the session cookie.

## Adding a new API endpoint

1. **Shared type** — add request/response shape to `src/shared/types/`
2. **Route handler** — add to `src/server/routes/*.ts`
3. **Mount it** — register in the server entry point with `ensureAuthenticated`
4. **Client service** — add a `fetch('/api/...')` wrapper
5. **React hook** — wrap with TanStack Query

## Environment variables

- **Server**: access via `process.env.VAR_NAME` (never expose to browser)
- **Client**: use `VITE_` prefix; always go through a validated config module
