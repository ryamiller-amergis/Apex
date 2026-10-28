---
name: ui
description: Directs a UI specialist to the UI standards skill, the design-system reference, and the component catalog before building or changing a screen. Use for a screen task. This is the UI role skill. The UI standards skill holds the screen rules. This skill records the evidence.
---

# UI role

## Purpose

The UI role skill serves UI/UX, or a UI specialist agent acting for one. It sends that agent to the UI standards skill, the design-system reference, and the component catalog before a screen is built or changed, and it requires an evidence note. It does not invent visual designs.

## When to use

Use this skill when a task builds or changes a screen. When the screen needs a new endpoint, follow the API contract skill first, then return here. Do not use this skill for a change that has no screen.

## Inputs

Read these before editing a screen. Stop if one cannot be read. Name the missing path and write no screen code.

1. [UI standards skill](../ui-standards/SKILL.md) (`.cursor/skills/ui-standards/SKILL.md`). Read the UI standards skill first.
2. [Design-system reference](../../../docs/design-system.md) (`docs/design-system.md`)
3. [Component catalog](../../../docs/component-catalog.md) (`docs/component-catalog.md`)
4. [UI package guide](../../../packages/ui/README.md) (`packages/ui/README.md`)
5. Tokens and theme: `packages/ui/src/tokens/index.ts` and `packages/ui/src/theme/createAppTheme.ts`
6. State components: `packages/ui/src/states/LoadingState.tsx`, `packages/ui/src/states/EmptyState.tsx`, and `packages/ui/src/states/ErrorState.tsx`
7. Worked screen: `apps/web/src/features/profile/ProfileForm.tsx`

## Required references

The Inputs list is the required set. The UI standards skill is first. The design-system reference and the component catalog come next. Do not copy token values into this skill or into a screen when the design-system reference already states them.

## Rules

The Enforced by cell is a gate id from `quality/quality-manifest.json`, or `Review`.

| ID     | Rule                                                                                                                                | Enforced by   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| UI-S01 | Read the UI standards skill first, then the design-system reference, then the component catalog.                                    | Review        |
| UI-S02 | Reuse catalog components and theme tokens. The evidence note lists the catalog components reused and the theme tokens used.         | Review        |
| UI-S03 | A screen that loads data has loading, empty, error, and loaded states. Each state needs a component test and an accessibility test. | accessibility |
| UI-S04 | When the catalog lacks a component, propose a catalog addition. Do not create a one-off styled component.                           | Review        |
| UI-S05 | If any of the four states has no component test or no accessibility test, do not report the screen as done. Name the state.         | Review        |
| UI-S06 | If the design-system reference cannot be read, stop and report the missing reference. Name `docs/design-system.md`.                 | Review        |

## Procedure

1. Read the UI standards skill first. Then read `docs/design-system.md` and `docs/component-catalog.md`. If any Inputs path cannot be read, stop and name it. Write no screen code.
2. Build the screen from catalog components and theme tokens. Follow the UI standards rules for layout, forms, query handling, and test ids.
3. Render loading, empty, error, and loaded. Use `LoadingState`, `EmptyState`, and `ErrorState` from the UI package when the catalog lists them.
4. Add a component test and an accessibility test for each of those four states.
5. If a needed component is not in the catalog, propose a catalog addition in the evidence note and do not create a one-off styled component.
6. Write the evidence note under Outputs. The screen is done only when every state in that note has both tests.

## Outputs

The screen change, plus a UI evidence note with these parts:

- Catalog components reused
- Theme tokens used
- State evidence, as a table with columns State, Component test, and Accessibility test, and one row each for loading, empty, error, and loaded
- Catalog addition proposed, or "none"

| State   | Component test | Accessibility test |
| ------- | -------------- | ------------------ |
| loading |                |                    |
| empty   |                |                    |
| error   |                |                    |
| loaded  |                |                    |

Fill the cells with the test file path. Leave no state blank when you claim the screen is done.

## Review checklist

Mark each item yes, no, or not applicable. A no is a failure.

| Item                                                                       | Evidence source           | Met? (yes, no, not applicable) |
| -------------------------------------------------------------------------- | ------------------------- | ------------------------------ |
| UI standards was read first (UI-S01)                                       | The session notes         |                                |
| Catalog components and theme tokens are listed (UI-S02)                    | The evidence note         |                                |
| Each state has a component test and an accessibility test (UI-S03, UI-S05) | The state evidence table  |                                |
| A missing catalog component was proposed, not styled once (UI-S04)         | Catalog addition proposed |                                |
| The design-system reference was readable (UI-S06)                          | `docs/design-system.md`   |                                |

## Stop conditions

Stop and report the missing piece. Do not guess. Write no screen code.

- `.cursor/skills/ui-standards/SKILL.md` cannot be read.
- `docs/design-system.md` cannot be read. Report the missing reference by that path.
- `docs/component-catalog.md` cannot be read.
- Any other Inputs path cannot be read. Name it.

A missing catalog component is not a stop. Propose a catalog addition and continue without a one-off styled component.

## Boundaries

- Do not generate a new visual design.
- Do not add visual regression tests.
- Do not hard-code a colour or a size. The UI standards skill and the design-system reference own tokens.
- Do not add an endpoint here. Use the API contract skill first when a screen needs one.
- Do not report the screen as done while any of loading, empty, error, or loaded lacks evidence. Name the state.
