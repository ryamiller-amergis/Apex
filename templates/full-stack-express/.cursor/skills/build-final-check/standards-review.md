# Standards Review Checklist

Shared between `.cursor/skills/build-final-check/SKILL.md`, `.cursor/skills/build-check/SKILL.md`, and `.cursor/skills/build-implementer/SKILL.md`.

Review every file changed since the base commit against the frozen `designSystemFile` (`.cursor/skills/design-system/SKILL.md`), `codingRules` (`.cursor/rules/react-mui-express.mdc`), `codeMap` (`.cursor/CODEMAP.md`), `.cursor/skills/api-contract/SKILL.md`, `.cursor/skills/ui-standards/SKILL.md`, and the revision's reuse list:

| Rule | Detect | Resolve |
|------|--------|---------|
| `duplicate_helper` | A new function, hook, or utility that repeats one already listed in the code map (`@project-scope/ui`, `@project-scope/contracts`, `apiClient`) or the reuse list | Replace the duplicate with the existing helper (`resolution: "fixed"`) |
| `hard_coded_colour` | A literal colour value (hex, rgb, hsl, or named colour) in a component or stylesheet instead of a theme token (`theme.vars.palette.*`) | Swap the literal colour for the design token (`resolution: "fixed"`) |
| `off_library_component` | A UI component imported or built from outside `@project-scope/ui` and theme-styled `@mui/material` primitives | Replace it with the catalog/MUI component (`resolution: "fixed"`) or record a justified exception (`resolution: "exception"` with a non-empty `exceptionReason`) |
| `missing_accessibility` | A control, form field, or request state (`LoadingState`, `EmptyState`, `ErrorState`) missing an accessible label, accessible name, `role="status"` / `role="alert"`, or keyboard focus handling | Add the missing accessibility attribute (`resolution: "fixed"`) or report it (`resolution: "open"`) with the file path and line number |

## Rules for reporting findings

- Every finding records `rule`, `file`, optional `line`, `resolution` (`"fixed" | "exception" | "open"`), and `detail` (max 500 characters, plain text, no code excerpts or secrets).
- When `resolution` is `"exception"`, `exceptionReason` is **required** and must state why the library component could not be used.
- When any of the three standards files (`designSystemFile`, `codingRules`, `codeMap`) cannot be read, stop and report:
  `{ "status": "unreadable_input", "path": "<file path>" }`.
