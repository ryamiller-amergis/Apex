# 0002: The template ships authentication but no authorization

- Status: Accepted
- Date: 2026-10-27
- Deciders: template maintainers

## Context and Problem Statement

Every product built from the template needs to know who is calling. Products differ widely in what each caller may do. A built-in role model would fit few of them and would be hard to remove. What access control should the template itself provide?

## Considered Options

- Authentication only: every route under `/api/v1` requires a principal, and no roles or permissions exist
- A simple built-in role model, such as user and admin
- A full permission catalog with role assignment screens

## Decision Outcome

Chosen option: "Authentication only", because it is the part every product shares, and it leaves each product free to add the authorization model it needs.

`AUTH_MODE` picks the identity adapter. The adapter returns a principal or nothing, and a request with no principal gets `401`. Handlers act only on the caller's own data, taken from the principal. The extension point for authorization is described in `apps/api/src/identity/README.md`.

### Consequences

- Good: no role tables, seed data, or admin screens to delete.
- Good: a product adds authorization in one place, after the principal is known.
- Bad: a product that needs authorization must design it before exposing shared or administrative data.
