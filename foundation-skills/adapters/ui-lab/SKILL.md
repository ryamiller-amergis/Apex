---
name: ui-lab
description: Project design-system adapter for UI Lab. Loads the generic ui-lab foundation and supplies THIS project's design tokens, components, and conventions. Auto-drafted at install from the repo; edit freely.
---

# UI Lab — Project Design System Adapter

<!-- Managed loader: this adapter loads its foundation from .apex/foundation/ui-lab/SKILL.md -->
This adapter extends the project-agnostic `ui-lab` foundation with this project's
own design system. The values below were auto-drafted from the repository at
install time and are safe to edit.

## Project

- Name: {{slot:projectName}}
- Stack signals:
{{slot:stack}}

## Design tokens (CSS custom properties)

{{slot:designTokens}}

## Components available in this project

{{slot:components}}

## Source directories

{{slot:dirConventions}}
