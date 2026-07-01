---
name: UI Lab — MaxView Design System
description: Component usage, spacing, typography, and interaction patterns for MaxView UI Lab generation. Complements maxview-colors.md which covers the full color palette.
---

# MaxView UI Lab — Design System Reference

This document provides the component usage rules, spacing scale, typography system, and interaction patterns for MaxView. When generating or editing UI in the UI Lab, apply every rule here alongside the canonical color palette from `maxview-colors.md`.

---

## 1. Component Usage Rules

### Buttons

| Variant | When to Use | Do NOT Use When |
|---------|-------------|-----------------|
| `contained` (primary) | Primary CTA — one per section max | Multiple CTAs compete |
| `outlined` | Secondary action next to a primary | Standalone primary action |
| `text` | Low-emphasis action (cancel, link-like) | Destructive actions |
| `contained` (error color) | Destructive / irreversible actions | Normal actions |

- Button height: **36px** (medium, default), **30px** (small), **42px** (large).
- Min-width: **64px**. Never shrink below. Use `fullWidth` only in forms inside modals.
- Icon buttons: 40×40px hit area.
- Disabled: use `disabled` prop — never hide a button that may become active.

### Form Controls

- **TextField**: label always present; use `helperText` for field-level guidance.
- Inputs: **40px** height for standard density; **36px** for dense forms.
- Required fields: asterisk suffix on label, never rely on placeholder alone.
- Error state: show `error` prop + `helperText` with reason.
- Do NOT use placeholder text as a substitute for a label.

### Data Display

| Component | When to Use |
|-----------|-------------|
| `Table` | 4+ rows of structured data with sortable columns |
| `List` | Sequential items without column structure |
| `Card` | Self-contained content units with title + actions |
| `Chip` | Tags, filters, status indicators (not for navigation) |
| `Badge` | Counts on icons/avatars only |
| `Tooltip` | Abbreviations or icon-only controls — always |

### Navigation

- Tabs: horizontal within a view. Max 6 tabs before using a Select or side-nav.
- Breadcrumb: when depth > 2 levels.
- Side drawer: persistent on desktop (≥960px); temporary/modal on mobile.
- Top AppBar: height **64px** desktop, **56px** mobile. Never remove on mobile.

### Feedback & Status

| Pattern | Component |
|---------|-----------|
| Operation success | `Alert severity="success"` or `Snackbar` autoHide 4s |
| Operation error | `Alert severity="error"` — inline, never only toast |
| Loading content | `CircularProgress` centered; `LinearProgress` at container top |
| Empty state | Centered icon + heading + body + optional CTA |
| Skeleton | Use `Skeleton` while loading, never blank space |

### Dialogs / Modals

- Max width: **600px** (small), **900px** (medium), **1200px** (large).
- Always include: title, close X button, primary action, cancel action.
- Destructive confirm dialogs: action button uses `color="error"` contained.
- Do NOT nest modals.

---

## 2. Spacing Scale

MaxView uses an **8px base grid**. All spacing values must be multiples of 4px. The MUI theme `spacing(n)` = `n * 8px`.

| Token | px | Use |
|-------|----|-----|
| `spacing(0.5)` | 4px | Tight icon gap |
| `spacing(1)` | 8px | Chip inner padding, icon-to-label |
| `spacing(1.5)` | 12px | Dense list item padding |
| `spacing(2)` | 16px | Standard component padding (buttons, inputs) |
| `spacing(3)` | 24px | Section inner padding |
| `spacing(4)` | 32px | Card padding |
| `spacing(6)` | 48px | Section vertical separation |
| `spacing(8)` | 64px | Page section separation |

### Layout Gutters

- Page content: `padding: 24px 32px` (desktop), `padding: 16px` (mobile).
- Grid: 12-column, `columnGap: 24px`, `rowGap: 16px`.
- Card grid: items min-width 280px, max-width 400px, 3-up on desktop.

### Radius

| Context | Value |
|---------|-------|
| Buttons, Inputs, Chips | `4px` |
| Cards, Dialogs, Popovers | `8px` |
| Avatars, full circles | `50%` |
| Tooltips | `4px` |

---

## 3. Typography

MaxView uses **Roboto** as its primary font. Do not use other font families.

| Role | Variant | Size / Weight | Usage |
|------|---------|--------------|-------|
| Page title | `h4` | 34px / 400 | One per page |
| Section heading | `h5` | 24px / 400 | Major section |
| Card title | `h6` | 20px / 500 | Card header |
| Subtitle | `subtitle1` | 16px / 400 | Supporting section title |
| Body default | `body1` | 16px / 400 | Main content text |
| Body secondary | `body2` | 14px / 400 | Supporting, captions |
| Labels / overlines | `caption` | 12px / 400 | Field labels, timestamps |
| Button text | `button` | 14px / 500 uppercase | Buttons only |

- Line-height: 1.5 for body, 1.2 for headings.
- Max readable line width: **72ch** (`max-width: 72ch` on paragraphs).
- Never set explicit `color` on text elements — use semantic `text.primary` / `text.secondary` tokens from `maxview-colors.md`.

---

## 4. Elevation / Shadows

| Level | Usage |
|-------|-------|
| 0 — flat | Inline elements, table rows |
| 1 — `box-shadow: 0 1px 3px rgba(0,0,0,0.12)` | Cards on white background |
| 2 — `box-shadow: 0 3px 6px rgba(0,0,0,0.16)` | Raised cards, dropdowns |
| 4 — `box-shadow: 0 6px 12px rgba(0,0,0,0.15)` | Dialogs, drawers |
| 8 — `box-shadow: 0 12px 24px rgba(0,0,0,0.14)` | Popovers, tooltips |

Do not use `box-shadow` values outside this scale.

---

## 5. Interaction & State Rules

### Hover States

- Interactive surfaces: `background-color: <base-color> + 8p alpha overlay` (e.g. primary.8p).
- Text/icon buttons: `background-color: primary.8p` on hover.
- Table rows: `background.hover` token from color palette.
- Never change shape or elevation on hover alone.

### Focus

- All interactive elements must show a visible focus ring.
- Focus ring: `outline: 2px solid primary.main; outline-offset: 2px`.
- Never `outline: none` without a replacement visible ring.

### Selected/Active

- Selected list item or tab: `primary.main` text + `primary.8p` background.
- Active nav: underline or left border in `primary.main`.

### Disabled

- Opacity: `0.38` on both text and icon.
- Cursor: `not-allowed`.
- Never hide disabled elements.

---

## 6. Responsive Breakpoints

| Breakpoint | Width | Behavior |
|------------|-------|----------|
| `xs` | 0–599px | Single column, full-width controls |
| `sm` | 600–899px | 2-column grid, side nav collapses |
| `md` | 900–1199px | 3-column grid, side nav persistent |
| `lg` | 1200–1535px | 4-column grid |
| `xl` | 1536px+ | Max content width 1440px centered |

---

## 7. Four Required UI States

Every generated screen must include all four states using HTML comment markers:

```
<!-- STATE:DEFAULT:START -->   ...default populated state...   <!-- STATE:DEFAULT:END -->
<!-- STATE:EMPTY:START -->     ...empty/zero-data state...     <!-- STATE:EMPTY:END -->
<!-- STATE:ERROR:START -->     ...error/failure state...       <!-- STATE:ERROR:END -->
<!-- STATE:LOADING:START -->   ...skeleton/spinner state...    <!-- STATE:LOADING:END -->
```

Only the DEFAULT state is visible at initial render. State tabs in the preview UI switch between them.

---

## 8. Accessibility Baseline

- All images: non-empty `alt`.
- Icon-only buttons: `aria-label`.
- Form inputs: `<label for>` or `aria-label`.
- Color alone must not convey meaning — always pair with text or icon.
- Touch targets: minimum **44×44px**.
- WCAG AA contrast required for all text.
