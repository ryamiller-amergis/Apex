# APEX Color Tokens (Light Theme)

Canonical CSS custom properties for the APEX (AI-Pilot) application.
Source: `src/client/App.css` — `:root` block.

When generating UI for APEX, use `var(--token-name)` in CSS. Never invent hex values.

---

## Brand

| Token | Value | Usage |
|-------|-------|-------|
| `--brand-primary` | `#2747D9` | Primary brand / interactive accent |
| `--brand-primary-light` | `#7C8CFF` | Soft primary tint — hover highlights, badges |
| `--brand-navy` | `#050506` | Deep dark background (dark-theme base) |
| `--brand-surface` | `#EEF2FF` | Light-theme accent surface / chip background |
| `--brand-surface-dark` | `#18181B` | Dark-theme surface / elevated card background |
| `--brand-text-inverse` | `#F9FAFB` | Text on dark or brand-colored fills |

## Background

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#F8FAFF` | Page-level background |
| `--bg-secondary` | `#EEF2FF` | Panel / header / sidebar background |
| `--bg-tertiary` | `#E0E7FF` | Selected row, hover surface, input background |

## Text

| Token | Value | Usage |
|-------|-------|-------|
| `--text-primary` | `#111827` | Default body and heading text |
| `--text-secondary` | `#4B5563` | Supporting text, labels, captions |
| `--text-muted` | `#6B7280` | Placeholder, de-emphasised content |

## Border

| Token | Value | Usage |
|-------|-------|-------|
| `--border-color` | `#D6DDF7` | Standard component borders |
| `--border-color-light` | `#E5E9FF` | Subtle dividers, hairlines |

## Accent

| Token | Value | Usage |
|-------|-------|-------|
| `--accent-color` | `#2747D9` | Interactive accent: buttons, links, focus rings |
| `--accent-hover` | `#1C33A6` | Accent hover state |
| `--on-accent` | `#ffffff` | Text/icons on accent fills (WCAG AA) |

## Status

| Token | Value | Usage |
|-------|-------|-------|
| `--success-color` | `#16A34A` | Success state, positive indicators |
| `--success-hover` | `#15803D` | Success hover |
| `--on-success` | `#0b1220` | Text/icons on success fills (WCAG AA) |
| `--error-color` | `#d32f2f` | Error / destructive state |

## Elevation

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `rgba(0,0,0,0.08)` | Subtle card / button elevation |
| `--shadow-md` | `rgba(0,0,0,0.14)` | Modal / elevated panel shadow |

---

## Dark Theme Overrides (`[data-theme="dark"]`)

Key overrides — backgrounds invert to near-black; accent lightens to `#7C8CFF`.

| Token | Dark value |
|-------|------------|
| `--bg-primary` | `#050506` |
| `--bg-secondary` | `#111113` |
| `--bg-tertiary` | `#18181B` |
| `--text-primary` | `#F9FAFB` |
| `--text-secondary` | `#D4D4D8` |
| `--text-muted` | `#A1A1AA` |
| `--border-color` | `#2A2A2E` |
| `--accent-color` | `#7C8CFF` |
| `--error-color` | `#ef5350` |

---

## Spacing and Typography

APEX uses a **4px base grid** (spacing scale: 4, 8, 12, 16, 24, 32 px).

Font stack: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, 'Helvetica Neue', sans-serif` — system fonts only, no external font import needed.

---

## Rules for AI generation

1. Use `var(--token-name)` in all CSS — never hardcode hex/rgba from this table.
2. Use `--accent-color` for primary buttons, active tabs, and focus rings.
3. Use `--on-accent` (white) for text placed on accent-colored fills.
4. Use `--error-color` for destructive buttons and error states.
5. Backgrounds layer: page = `--bg-primary`, panels/headers = `--bg-secondary`, hover/selected = `--bg-tertiary`.
6. Dark mode is automatic via `[data-theme="dark"]` — do not add manual dark-mode JS checks.
