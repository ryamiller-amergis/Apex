# Feature slices

A feature slice is one product area. It is not a workspace member. The [module map](module-map.md) names the five members. A slice is the files for that area inside those members. Copy the profile slice. Do not invent a workspace member, and do not add a package for a feature.

## Profile slice

This is the copy target. A new slice uses the same kinds of files.

| Piece            | Profile path                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------- |
| Web feature      | `apps/web/src/features/profile/`                                                          |
| Routes           | `apps/web/src/app/routes.tsx` (lazy `/profile` and `/profile/details/edit`)               |
| Shell navigation | `apps/web/src/app/App.tsx` (`navItems`, id `profile`, label `Profile`, path `/profile`)   |
| Contract         | `packages/contracts/src/routes/me.ts`, registered in `packages/contracts/src/registry.ts` |
| HTTP handlers    | `apps/api/src/routes/me.ts`                                                               |
| Service          | `apps/api/src/services/profileService.ts`                                                 |
| Store            | `apps/api/src/persistence/appUserStore.ts` and `apps/api/src/persistence/schema.ts`       |
| Migration        | `apps/api/drizzle/`                                                                       |

The web feature folder holds the page, the form, the query hook, the mutation hook, the query keys, and the test ids. Tests sit next to the files they cover.

## A new slice

1. Pick a kebab-case name, such as `orders`. Use that name for the feature folder, the route file, the service, and the nav id.
2. Add the contract route with the [API contract skill](../.cursor/skills/api-contract/SKILL.md) before any handler or screen.
3. Add the handler, the service, and the store. The handler calls the service. The service calls the store. The handler does not import Drizzle or `pg`. Only `apps/api/src/persistence/` may.
4. Read the caller with `getPrincipal`. Do not take a person identifier from the path, the query, or the body.
5. Add the screen with the [UI standards skill](../.cursor/skills/ui-standards/SKILL.md). Register a lazy route in `apps/web/src/app/routes.tsx` and one `NavItem` in `apps/web/src/app/App.tsx`.
6. A schema change ships a reviewed SQL migration with the Drizzle change. Follow the [migrations runbook](runbooks/migrations.md).

The planner names each slice it touches and quotes the profile piece it copies. A path that is not in the table above, and not a new file of the same kind, is not a slice path.
