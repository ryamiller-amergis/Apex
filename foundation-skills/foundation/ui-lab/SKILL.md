---
name: ui-lab
description: Project-agnostic UI generation workflow — required UI states, accessibility baseline, and generation/edit rules. Project design tokens, components, and spacing live in the project adapter, never here.
---

# UI Lab — Generation Foundation (project-agnostic)

This foundation defines the invariant workflow for generating and editing UI
prototypes. It contains no project-specific design system. The consuming
project's adapter supplies the actual tokens, components, spacing, and typography.

## 1. Four required UI states

Every generated screen must include all four states using HTML comment markers:

```
<!-- STATE:DEFAULT:START -->   ...default populated state...   <!-- STATE:DEFAULT:END -->
<!-- STATE:EMPTY:START -->     ...empty/zero-data state...     <!-- STATE:EMPTY:END -->
<!-- STATE:ERROR:START -->     ...error/failure state...       <!-- STATE:ERROR:END -->
<!-- STATE:LOADING:START -->   ...skeleton/spinner state...    <!-- STATE:LOADING:END -->
```

Only the DEFAULT state is visible at initial render; state tabs switch between them.

## 2. Generation rules

- Use only design tokens, components, and spacing values supplied by the project adapter. Do not invent colors, fonts, or spacing values.
- Prefer the project's canonical components over bespoke markup when the adapter lists an equivalent.
- Keep one primary call-to-action per section; secondary actions use lower-emphasis variants.
- Every interactive element has a visible focus state; never remove focus affordances without a replacement.

## 3. Edit rules

- Preserve the four-state structure and any existing token usage when editing an existing prototype.
- Maintain design-system fidelity: reuse the adapter's tokens/spacing/typography rather than introducing new values.

## 4. Accessibility baseline

- All images: non-empty `alt`.
- Icon-only controls: `aria-label`.
- Form inputs: associated `<label>` or `aria-label`.
- Color alone must not convey meaning — always pair with text or icon.
- Touch targets: minimum 44x44px.
- WCAG AA contrast required for all text.
