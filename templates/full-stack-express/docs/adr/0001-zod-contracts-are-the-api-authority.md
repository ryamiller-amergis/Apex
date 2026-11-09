# 0001: Zod route definitions are the API contract

- Status: Accepted
- Date: 2026-10-27
- Deciders: template maintainers

## Context and Problem Statement

The web client and the API must agree on every path, request body, response body, and error shape. Hand-written TypeScript interfaces, a hand-edited OpenAPI file, and runtime validation drift apart when each is maintained on its own. Which artifact is the single source of the contract?

## Considered Options

- Zod schemas in a shared package, with the OpenAPI document generated from them
- A hand-written OpenAPI document, with types generated from it
- TypeScript interfaces shared between client and server, with no runtime validation

## Decision Outcome

Chosen option: "Zod schemas in a shared package", because one definition gives runtime validation in the API, response parsing in the client, derived TypeScript types in both, and a generated OpenAPI 3.1 document for everyone else.

Each route is a `defineRoute` call in `packages/contracts/src/routes/`. `pnpm openapi:generate` writes `packages/contracts/openapi/openapi.json`. `pnpm openapi:check` fails when that file is stale, and `pnpm routes:check` fails when the API registers a different set of routes.

### Consequences

- Good: a contract change is one edit, and three checks catch drift.
- Good: the contracts package imports only `zod`, so the browser bundle can include it.
- Bad: OpenAPI features that Zod cannot express need a change to the document builder in `packages/contracts/src/openapi/build-document.ts`.
- Bad: the committed document must be regenerated and committed with every contract change.
