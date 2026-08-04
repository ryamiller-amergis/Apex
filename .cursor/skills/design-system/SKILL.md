---
name: design-system
description: Apex design system reference for Bedrock prototype and design-plan generation. Covers Apex brand tokens (light theme), top AppHeader shell (no MaxView left sidebar), primary routes, component conventions, interaction states, accessibility baseline, and self-contained HTML prototype rules. Load this whenever generating or regenerating an Apex project prototype or design plan.
---

# Apex Design System — Prototype Reference

> This file is the authoritative design system reference for **Apex (AI Pilot platform)**
> prototype and design-plan generation via the APEX Bedrock engine.
> Consumed by Apex's `prototypeContextService` when the **Apex** project's
> `skillRepo` points at this repo and `prototypeDesignSystemPath` resolves here.
>
> **Do NOT use MaxView tokens, MaxView left sidebar, or MaxView routes.**
>
> **AI agents using this file must:**
> - Use ONLY the tokens below for all colors, shadows, and borders.
> - Pair accent and success fills with their semantic foreground tokens; never hard-code white text or icons on theme-token fills.
> - Never invent, approximate, or sample hex/rgba values not listed here.
> - Apply the **top AppHeader** shell (not a left sidebar) as described below.
> - Prefer routes from the Apex Screen Inventory section when deciding `update-page`.
> - Follow the self-contained HTML rules so the prototype survives Apex's HTML sanitizer.

---

## 1. Color Tokens (Light Theme) — AUTHORITATIVE

Pick by **semantic role**, not visual similarity. Source of truth: `src/client/App.css` `:root`.

| Token | Value | Usage |
|-------|-------|-------|
| `brand.primary` | `#2747D9` | Brand mark, primary accents |
| `brand.primaryLight` | `#7C8CFF` | Soft brand tint / dark-theme accent |
| `brand.navy` | `#050506` | Dark brand surface |
| `brand.surface` | `#EEF2FF` | Soft indigo surface |
| `brand.textInverse` | `#F9FAFB` | Text on dark brand surfaces |
| `bg.primary` | `#F8FAFF` | App / page background |
| `bg.secondary` | `#EEF2FF` | Panels, secondary surfaces |
| `bg.tertiary` | `#E0E7FF` | Hover chips, selected soft fill |
| `text.primary` | `#111827` | Default body and heading text |
| `text.secondary` | `#4B5563` | Supporting text, captions |
| `text.muted` | `#6B7280` | Meta, timestamps, placeholders |
| `border.color` | `#D6DDF7` | Default borders / dividers |
| `border.light` | `#E5E9FF` | Subtle borders |
| `accent.main` | `#2747D9` | Primary buttons, links, focus rings |
| `accent.hover` | `#1C33A6` | Primary hover |
| `on.accent` | `#ffffff` | Text/icons on accent fills |
| `success.main` | `#16A34A` | Success status |
| `success.hover` | `#15803D` | Success hover |
| `on.success` | `#0b1220` | Text on success fills |
| `error.main` | `#d32f2f` | Errors, destructive actions |
| `shadow.sm` | `rgba(0, 0, 0, 0.08)` | Cards, header |
| `shadow.md` | `rgba(0, 0, 0, 0.14)` | Dropdowns, modals |
| `calendar.bg` | `#F8FAFF` | Calendar page bg |
| `calendar.eventBg` | `#E0E7FF` | Calendar event chip bg |
| `calendar.eventBorder` | `#2747D9` | Calendar event border |
| `calendar.eventText` | `#1C33A6` | Calendar event text |

### CSS :root block for prototypes

Paste this block into the prototype's `<style>` and reference variables throughout:

```css
:root {
  --brand-primary: #2747D9;
  --brand-primary-light: #7C8CFF;
  --brand-navy: #050506;
  --brand-surface: #EEF2FF;
  --brand-text-inverse: #F9FAFB;
  --bg-primary: #F8FAFF;
  --bg-secondary: #EEF2FF;
  --bg-tertiary: #E0E7FF;
  --text-primary: #111827;
  --text-secondary: #4B5563;
  --text-muted: #6B7280;
  --border-color: #D6DDF7;
  --border-color-light: #E5E9FF;
  --accent-color: #2747D9;
  --accent-hover: #1C33A6;
  --on-accent: #ffffff;
  --success-color: #16A34A;
  --success-hover: #15803D;
  --on-success: #0b1220;
  --error-color: #d32f2f;
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.08);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.14);
  /* Neon glow — `none` on light/classic themes; only the neon-category
     production themes override these. Prototypes stay light, so leave as none. */
  --glow-accent: none;
  --glow-accent-strong: none;
  --glow-text: none;
  --radius-sm: 6px;
  --radius: 8px;
  --radius-lg: 12px;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', sans-serif;
}
```

**Prototype theme:** generate for **light** theme only unless the PRD explicitly requires dark/Amergis.

---

## 2. Typography

Apex uses the **system UI stack** (not Roboto-only, not MaxView MUI type scale).

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', sans-serif;
```

| Role | Size / Weight | Usage |
|------|--------------|-------|
| Page title | 22–24px / 600 | One per page content header |
| Section heading | 16–18px / 600 | Major section |
| Card / panel title | 14–16px / 600 | Card header |
| Body | 14px / 400 | Main content |
| Caption / meta | 12px / 400 | Timestamps, helper text |
| Button text | 13–14px / 500 | Buttons (sentence case, not ALL CAPS) |

Line-height: ~1.45 body, ~1.25 headings. Max readable paragraph width: `72ch`.

---

## 3. Spacing

4/8px base grid: `4, 8, 12, 16, 24, 32, 48`.
Page content padding: `16px 24px` desktop, `12px 16px` mobile.

---

## 4. Elevation / Shadows

| Level | Value | Usage |
|-------|-------|-------|
| Header / card | `var(--shadow-sm)` | App header, cards |
| Raised | `var(--shadow-md)` | Dropdowns, modals, drawers |

---

## 5. App Shell — TOP HEADER (not MaxView left nav)

Apex uses a **top application header** + full-width content below.  
**Do NOT render a MaxView-style left purple/navy sidebar.**

### Top AppHeader (every prototype)

- Sticky top bar, ~56–64px tall.
- Background: `var(--bg-primary)` with `1px solid var(--border-color)` bottom (or light `var(--shadow-sm)`).
- **Left:** Apex brand mark + wordmark **"Apex"** (optional small "BETA" chip). Brand mark uses `var(--accent-color)`.
- **Center / under-brand (desktop):** horizontal primary nav links (see Nav items). Active item: `var(--accent-color)` text + subtle `var(--bg-tertiary)` pill/underline.
- **Right:** optional project/repo switcher, notification bell, user avatar menu (initials circle on `var(--accent-color)`).
- **Mobile (≤768px):** hamburger opens a left **drawer** (280px) listing the same nav items — this is the only left-panel chrome, and only for mobile.

### Nav items (role/menu gated — show a realistic subset)

| Label | Route | Notes |
|-------|-------|-------|
| Home | `/home` | Agent Home |
| Calendar | `/calendar` | Scrum calendar |
| Planning | `/planning/dev-stats` | Planning hub (tabs underneath) |
| Cloud Cost | `/cloud-cost` | Azure cost |
| AI Cost Analytics | `/ai-cost` | AI usage/cost |
| Interview | `/backlog` | Interviews / PRD / prototypes / design docs |
| ADR | `/adr` | Architecture Decision Records |
| My Work | `/my-work` | Dev workbench |
| Standup | `/standup` | Daily standup |
| UI Lab | `/ui-lab` | UI Lab (UI/UX group) |
| Apex Backlog | `/feature-requests` | Feature requests (Apex project) |
| Design Module | `/design-module` | Design modules |
| Admin | `/admin/roles` | Project admin |

### Content area

- Below the header: full-width workspace on `var(--bg-primary)`.
- Cards/panels use `var(--bg-secondary)` or white (`#ffffff`) with `var(--border-color)` and `var(--radius)`.
- Prefer Apex patterns: tab bars, split panes (list + detail), review sidebars — not MaxView MUI DataGrid chrome.

---

## 6. Apex Screen Inventory (routes for design plan + EXTEND)

When deciding `update-page`, `targetRoute` **must** be one of these Apex routes (single route only).  
For greenfield features with no natural home, use `new-page` and `targetRoute: null`.

### Core

| Route | Component / File | Purpose | Archetype | States |
|-------|------------------|---------|-----------|--------|
| `/` | `App.tsx` (project selector) | Choose Apex project before entering the shell | Hub | loading: project list; empty: no projects |
| `/home` | `AgentHome.tsx` | Agent Home — skill pills, start chat, recent threads | Hub | empty: no threads; loading: skeletons |
| `/calendar` | `ScrumCalendar.tsx` | Sprint calendar + unscheduled work items | Calendar | empty: no items; loading: calendar skeleton |
| `/cloud-cost` | `CloudCost.tsx` | Cloud cost dashboards | Dashboard | empty/error/loading |
| `/ai-cost` | `AiCost*.tsx` | AI cost analytics | Dashboard | empty/error/loading |
| `/adr` | `AdrsDashboard.tsx` | ADR list / dashboard | List | empty: no ADRs |
| `/adr/:id` | `AdrChatView.tsx` | ADR interview / review thread | Detail | loading/error |
| `/my-work` | `DevWorkbenchView.tsx` | Developer workbench | Hub | empty: no assignments |
| `/my-work/session/:id` | `DevSessionView.tsx` | Active dev session | Detail | loading/error |
| `/standup` | `StandupCeremonyView.tsx` | Daily standup ceremony | Form / Hub | empty/loading |
| `/standup/manage` | `StandupManageView.tsx` | Standup admin/config | Form | — |
| `/standup/summary` | `StandupSummaryView.tsx` | Standup summary | Detail | — |
| `/ui-lab` | `UiLabView.tsx` | UI Lab designs | Hub | empty: no designs |
| `/feature-requests` | `FeatureRequestsView.tsx` | Apex Backlog / feature requests | List | empty/loading |
| `/design-module` | `DesignModuleView.tsx` | Design modules | Hub | empty/loading |
| `/pdf-tools` | `PdfAssemblyView.tsx` | PDF assembly tools | Form | — |
| `/notifications` | `NotificationsPage.tsx` | In-app notification center | List | empty: no notifications |
| `/platform-admin` | `PlatformAdmin.tsx` | Platform-level admin | Hub | — |

### Planning

| Route | Component / File | Purpose | Archetype |
|-------|------------------|---------|-----------|
| `/planning/dev-stats` | `DevStats.tsx` | Developer stats | Dashboard |
| `/planning/qa` | `QAMetrics.tsx` | QA metrics | Dashboard |
| `/planning/ai-analysis` | `AIAnalysis.tsx` | AI analysis | Dashboard |
| `/planning/roadmap` | `RoadmapView.tsx` | Roadmap | Dashboard |
| `/planning/releases` | `ReleaseView.tsx` | Releases | List |

### Interview / PRD / Prototype / Design Doc pipeline

| Route | Component / File | Purpose | Archetype |
|-------|------------------|---------|-----------|
| `/backlog` | `InterviewsDashboard.tsx` | Interviews / PRDs / design artifacts dashboard | Hub |
| `/backlog/interview/:id` | `InterviewChatView.tsx` | Design interview chat | Detail |
| `/backlog/prd/:id` | `PrdReviewView.tsx` | PRD review | Detail |
| `/backlog/design-plan/:id` | `DesignPlanReviewView.tsx` | Design plan review (decisions, routes, screenshots) | Detail |
| `/backlog/design-prototypes/:id` | `DesignPrototypeReviewView.tsx` | Per-feature HTML prototype review | Detail |
| `/backlog/design-doc/:id` | `DesignDocReviewView.tsx` | Design doc review | Detail |

### Project Admin

| Route | Component / File | Purpose | Archetype |
|-------|------------------|---------|-----------|
| `/admin/roles` | `AdminRoles.tsx` | Roles & permissions | Form / List |
| `/admin/users` | `AdminUsers.tsx` | Users | List |
| `/admin/groups` | `AdminGroups.tsx` | Groups | List |
| `/admin/project-settings` | `AdminProjectSettings.tsx` | Project skill settings (repo, prototype paths, models) | Form |
| `/admin/notifications` | `NotificationPreferences` / admin notifications | Notification config | Form |

---

## 7. Component Conventions (Apex React patterns)

| Component | Key rules |
|-----------|-----------|
| Primary button | `background: var(--accent-color); color: var(--on-accent); border-radius: var(--radius); height ~36px; padding 8px 16px`. Hover → `var(--accent-hover)`. |
| Success button | `background: var(--success-color); color: var(--on-success)`. Hover → `var(--success-hover)` while retaining `var(--on-success)`. |
| Secondary / outlined | Transparent bg, `1px solid var(--border-color)` or accent border; text `var(--text-primary)` or accent. |
| Text inputs | Label above; 36–40px height; border `var(--border-color)`; focus ring `2px solid var(--accent-color)`. |
| Cards / panels | `background: #fff` or `var(--bg-secondary)`; border `1px solid var(--border-color)`; `border-radius: var(--radius)`; padding 16–24px. |
| Tabs | Underline or pill active state with `var(--accent-color)`. |
| Tables / lists | Row hover `var(--bg-secondary)`; dividers `var(--border-color-light)`. |
| Modals | Centered overlay; `var(--shadow-md)`; `var(--radius-lg)`; primary + cancel actions. |
| Status chips | Soft fills from `var(--bg-tertiary)` / success / error; never MaxView purple tertiary as brand. |
| Review annotation (EXTEND only) | Use dashed `var(--accent-color)` border + `NEW: {feature}` label — **not** MaxView `#a46bff` purple. |

---

## 8. Interaction & Focus States

- **Hover:** surfaces → `var(--bg-tertiary)` / `var(--bg-secondary)`; primary button → `var(--accent-hover)`.
- **Focus:** `outline: 2px solid var(--accent-color); outline-offset: 2px`. Never remove.
- **Selected/active:** accent text + soft tertiary background.
- **Disabled:** `opacity: 0.45`, `cursor: not-allowed`. Never hide.

### Neon glow (production themes only)

The neon-category themes (neon, volt, plasma, pink, ice, flare) express their identity
through an accent **glow** applied to signal-carrying elements — the primary CTA,
active/selected states, focus rings, and live indicators — via `box-shadow: var(--glow-accent)`
(or `var(--glow-accent-strong)` for a hero CTA / featured card). The token is `none` on
light/classic themes, so it is safe to reference everywhere and is a no-op in prototypes.
Never hardcode a neon `box-shadow` or gate it with a JS theme check; reserve glow for a
small set of high-signal elements, not every surface. Full guidance:
`.cursor/rules/ui-design-standards.mdc` → "Neon Glow".

### Theme-safe filled controls — mandatory

- Any solid or gradient background containing `var(--accent-color)` or `var(--accent-hover)` must use `color: var(--on-accent)`.
- Any solid or gradient background containing `var(--success-color)` or `var(--success-hover)` must use `color: var(--on-success)`.
- SVG icons on these fills must inherit `currentColor` from the semantic foreground token. Do not use `fill: #fff`, `stroke: #fff`, `color: white`, or `color: var(--bg-primary)`.
- These rules apply to buttons, badges, avatars, icon tiles, selected states, hover states, and generated prototypes across every theme, including high-luminance accents like Aurora and Volt.
- Production CSS is enforced by `npm run lint:theme-contrast`; do not bypass the check with an equivalent hard-coded light color.

---

## 9. Visual Annotation Convention (EXTEND / update-page)

When a feature **extends an existing Apex page**, wrap only the new/changed element(s) with:
- **2px dashed `var(--accent-color)` (#2747D9) border** with 8px padding.
- Floating label: `NEW: {featureName}` — `background: var(--accent-color); color: var(--on-accent); font: 10px/1 bold; padding: 2px 6px`.
- Markers: `<!-- NEW_FEATURE:START -->` … `<!-- NEW_FEATURE:END -->`.

For **NEW-page** features, skip the annotation. Use four STATE markers:
`<!-- STATE:DEFAULT:START/END -->`, `<!-- STATE:EMPTY:START/END -->`, `<!-- STATE:ERROR:START/END -->`, `<!-- STATE:LOADING:START/END -->`.

---

## 10. Accessibility Baseline

- WCAG AA contrast for text and meaningful UI.
- Icon-only buttons have `aria-label`.
- Every input has a visible label or `aria-label`.
- Color never the sole meaning carrier.
- Visible focus ring on every interactive element.
- Touch targets ≥ 44×44px on mobile patterns.

---

## 11. Self-Contained Prototype Rules (Apex sanitizer compliance)

Prototypes MUST:

- Inline ALL CSS in a `<style>` block and ALL JS in a single `<script>` at end of `<body>`.
- Use NO `<link>`, `<base>`, or `<meta http-equiv>` tags.
- Use NO external `http(s)` `src`/`href` and NO `url(https://…)` (no CDN, no remote fonts/images).
- Make NO network calls (`fetch`, `XMLHttpRequest`, `window.open`, `window.location` are neutralised).
- Keep `<a href="#">` for nav (sandbox disables real navigation).
- Icons: inline SVGs (`24×24`, `fill="currentColor"`). No emoji.
- Avatars: colored circle with initials on `var(--accent-color)` and foreground `var(--on-accent)`.

Inline `<script>` and `on*` handlers ARE allowed for tabs, toggles, modals, dropdowns.
