---
name: design-system
description: Project-agnostic design system reference document consumed by APEX when generating feature prototypes. Defines the required structure for design tokens, components, and shell conventions.
---

# Design System — Foundation

This file is **not** a Cursor workflow skill. It is a design system reference document that APEX reads from the project's ADO repo when generating feature prototypes via Bedrock. Its content is injected directly into the prototype generation prompt as the **authoritative design and color source**.

---

## Required sections (every adapter must have all four)

### 1. Design Tokens — `:root` CSS block

A fenced `css` block containing a `:root { }` declaration with **all** CSS custom properties used across the application. This block is the sole color and spacing source; the AI is instructed never to invent hex values not listed here.

### 2. Component Library

A list of the project's UI component names. The prototype generation AI uses these when deciding which controls and patterns to render so the output matches the real component vocabulary.

### 3. App Shell

Tech stack, persistent chrome (sidebar, top nav, breadcrumbs, footer), and navigation structure. The AI uses this to reproduce the surrounding shell correctly on every generated screen.

### 4. Spacing and Typography

The spacing scale (e.g. 4 / 8 / 12 / 16 / 24 / 32 px) and font-role conventions (heading, body, label, caption). Prevents the AI from inventing an arbitrary scale.

---

## How APEX uses this file

1. `prototypeContextService` fetches `.cursor/skills/design-system/SKILL.md` from the project's ADO repo (path configurable via **prototypeDesignSystemPath** in project settings; defaults to this path).
2. The raw markdown is passed as `ctx.designSystemMarkdown` to the Bedrock prototype prompt.
3. Bedrock is instructed: *"Use ONLY the colors and tokens defined in this Design System section. Never invent, approximate, or sample any hex/rgba value not listed here."*

---

## After bootstrap — team review checklist

Bootstrap auto-fills tokens and components from a static scan. Teams should review and refine before committing:

- [ ] Remove Docusaurus / third-party CSS vars — keep only your app's design tokens.
- [ ] Verify the component list reflects your actual UI library, not test files or stubs.
- [ ] Add a **App Shell** section describing sidebar items, top navigation, and persistent chrome.
- [ ] Add your spacing scale and primary font stack to the Typography section.
- [ ] Commit. APEX picks up the new version on the next prototype generation automatically (10-minute cache TTL).
