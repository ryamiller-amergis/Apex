# Code map

Copy this file to `.cursor/CODEMAP.md` in the target repository. Keep each entry to one line with the full repo-relative path. Update it in the same change when a listed path moves.

## Top level

- `src/client/`: React + MUI app (Vite)
- `src/server/`: Express API
- `src/shared/`: types and schemas used by client and server
- `.cursor/skills/design-system/SKILL.md`: design system — components, tokens, icons, layout, accessibility
- `.cursor/rules/`: coding rules

## Client

- `src/client/main.tsx`: entry point; mounts `ThemeProvider` and the router
- `src/client/theme.ts`: MUI theme — the source of every token
- `src/client/components/`: UI components
- `src/client/hooks/`: TanStack Query data hooks
- `src/client/pages/`: one folder per route

## Server

- `src/server/index.ts`: Express entry point
- `src/server/routes/`: route handlers
- `src/server/services/`: business logic

## Commands

- Type-check: TODO
- Lint: TODO
- Related tests: TODO
- Unit suite: TODO
