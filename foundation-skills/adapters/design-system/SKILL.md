---
name: design-system
description: Project design system reference for APEX prototype generation. Bootstrap-filled from repo CSS tokens and components. Customize before committing.
---

# {{slot:projectName}} Design System

> This file is read by APEX when generating feature prototypes. Edit it to match
> your project's actual design system, then commit. APEX picks up changes within
> 10 minutes (cache TTL). See `.apex/foundation/design-system/SKILL.md` for the
> full authoring guide.

---

## Design Tokens

```css
:root {
{{slot:cssTokens}}
}
```

---

## Component Library

Components available in this project (bootstrap-detected — trim to your actual UI library):

{{slot:components}}

---

## App Shell

- **Project:** {{slot:projectName}}
- **Context / product guide:** `{{slot:contextFile}}`
- **Agent reference:** `{{slot:agentsFile}}`
- **Source roots:**
{{slot:dirConventions}}

### Navigation items (bootstrap-detected from shell components)

{{slot:navItems}}

### Shell component files

{{slot:shellFiles}}

> Review the nav items above. Add or correct any entries that weren't detected
> (e.g. top bar, breadcrumbs, footer structure). Delete this note when done.

---

## Spacing Scale

4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px

---

## Typography

```css
:root {
{{slot:typographyTokens}}
}
```

> Review the font tokens above. Add explicit heading/body/label sizes if your
> project uses them. Delete this note when done.

---

## Generation rules (enforced by APEX)

- Use **only** the CSS custom properties in the `:root` block above. Never hardcode hex values.
- Reference component names from the Component Library when describing UI elements.
- Maintain the App Shell structure above across all generated screens.
- Prefer existing component patterns over inventing new ones.
