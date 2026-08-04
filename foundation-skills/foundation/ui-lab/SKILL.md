---
name: ui-lab
description: Project-agnostic UI Lab generation skill. Produces HTML screens with four required UI states, WCAG AA accessibility baseline, and project-specific design system rules loaded from the project adapter. Use when generating, previewing, or editing UI screens in the UI Lab.
---

# UI Lab — Foundation

This foundation defines the invariant contract every UI Lab-generated screen must satisfy. Project-specific design tokens, component libraries, spacing scales, and typography are defined in the project adapter that wraps this foundation.

---

## Invariant contract (all projects)

### Four required UI states

Every generated screen **must** include all four states using HTML comment markers. Only the DEFAULT state is visible at initial render; the preview UI switches between them.

```html
<!-- STATE:DEFAULT:START -->
...default populated state...
<!-- STATE:DEFAULT:END -->

<!-- STATE:EMPTY:START -->
...empty/zero-data state...
<!-- STATE:EMPTY:END -->

<!-- STATE:ERROR:START -->
...error/failure state...
<!-- STATE:ERROR:END -->

<!-- STATE:LOADING:START -->
...skeleton/spinner state...
<!-- STATE:LOADING:END -->
```

### Accessibility baseline (WCAG AA — non-negotiable)

- All images: non-empty `alt` attribute.
- Icon-only buttons: `aria-label`.
- Form inputs: `<label for>` or `aria-label`.
- Color alone must not convey meaning — always pair with text or icon.
- Touch targets: minimum **44×44px**.
- WCAG AA contrast required for all text.
- All interactive elements must show a visible focus ring; never `outline: none` without a replacement ring.

### Component usage principles (generic)

| Pattern | Rule |
|---------|------|
| Primary action | One primary CTA per section maximum |
| Destructive actions | Use error/danger color variant |
| Form labels | Always present; never rely on placeholder alone |
| Disabled elements | Never hide; use `disabled` prop or attribute |
| Empty states | Centered icon + heading + body + optional CTA |
| Loading states | Skeleton or spinner; never blank space |
| Error states | Inline error message; never only a toast |
| Modals / Dialogs | Always include: title, close control, primary action, cancel |
| Nested modals | Never nest modals |

### Generation rules

1. Read the project adapter to load design tokens, component names, spacing scale, typography, and project-specific patterns before generating.
2. Never hardcode color hex values or sizes that are not backed by a design token from the adapter.
3. All spacing and sizing must use the project's spacing scale from the adapter.
4. Typography roles (heading, body, label, caption) must use the project's type system from the adapter.
5. Generate all four states for every screen; do not skip any state.
6. Validate WCAG AA contrast for all text against the adapter's token values.

---

## Generation workflow

1. Load this foundation (invariant contract + generation rules).
2. Load the project adapter for design tokens, components, spacing, and typography.
3. Parse the user's screen request.
4. Generate the HTML with all four states, applying adapter tokens throughout.
5. Self-check: verify all four state markers are present, all accessibility requirements are met, and no hardcoded values are used.
