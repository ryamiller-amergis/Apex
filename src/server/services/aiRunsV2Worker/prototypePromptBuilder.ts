/**
 * Builds prototype prompt context from the execution specification alone.
 *
 * These sections are ported from `bedrockService.buildCatalogSection` and
 * `buildScreensContextSection`, which read the catalog, palette, and Figma
 * navigation inline through `designSystemService`. Wording is kept identical
 * so moving the work to a worker does not change what the model produces —
 * only where the inputs come from.
 *
 * The remaining prototype prompt sections (feature framing, layout variant,
 * visual reference, output rules) still live in `bedrockService` and move here
 * in the same way.
 */
import type {
  AiRunV2VisualSpecification,
  DesignPrototypeVisualSpecification,
  ProjectPrototypePrompt,
} from '../../../shared/types/aiRunV2VisualSpec';
import {
  buildComponentDetailCoverageSection,
  buildPrototypeSourceSection,
} from '../designContext/prototypePromptSections';

type CatalogRoute = Readonly<{ path: string; title: string }>;

type SpecCatalog = Readonly<{
  routes?: ReadonlyArray<CatalogRoute>;
  componentNames?: ReadonlyArray<string>;
  componentDescriptions?: Record<string, string>;
  routeLayoutHints?: Record<string, string>;
  uiKnowledgeBase?: string;
  componentDetailCoverage?: {
    omittedPaths?: ReadonlyArray<string>;
  };
}>;

type SpecScreen = Readonly<{
  route?: string;
  purpose?: string;
  userTypes?: ReadonlyArray<string>;
  states?: string;
}>;

type SpecSourceFile = Readonly<{ path: string; content: string }>;

function asCatalog(value: unknown): SpecCatalog {
  return (value ?? {}) as SpecCatalog;
}

function asScreens(value: unknown): ReadonlyArray<SpecScreen> {
  return Array.isArray(value) ? (value as SpecScreen[]) : [];
}

function asSourceFiles(value: unknown): ReadonlyArray<SpecSourceFile> {
  return Array.isArray(value) ? (value as SpecSourceFile[]) : [];
}

function asPaths(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value) ? (value as string[]) : [];
}

function buildCatalogSection(spec: AiRunV2VisualSpecification): string {
  const catalog = asCatalog(spec.designSystem.catalog);
  const parts: string[] = [];

  // The knowledge base goes first — it describes each existing screen in
  // detail, which is the richest context for new-page vs update-page.
  if (catalog.uiKnowledgeBase?.trim()) {
    parts.push(
      `### Existing screens — detailed descriptions\n\n${catalog.uiKnowledgeBase.trim()}`,
    );
  }

  const routeLayoutHints = catalog.routeLayoutHints ?? {};
  const routes = catalog.routes ?? [];
  const routeList =
    routes.length > 0
      ? routes
          .map((route) => {
            const layout = routeLayoutHints[route.path];
            return `- \`${route.path}\` — ${route.title}${
              layout ? ` *(layout: ${layout})*` : ''
            }`;
          })
          .join('\n')
      : spec.designReference.navItems
          .map((item) => `- \`${item.route}\` — ${item.label}`)
          .join('\n');

  parts.push(`### Existing application pages (MaxView sidebar nav)\n\n${routeList}`);

  const componentNames = catalog.componentNames ?? [];
  if (componentNames.length > 0) {
    const names = componentNames.slice(0, 40);
    const descriptions = catalog.componentDescriptions ?? {};
    const componentLines = names.map((name) => {
      const description = descriptions[name];
      return description ? `- \`${name}\` — ${description}` : `- \`${name}\``;
    });
    parts.push(
      '### Existing components in the codebase\n\n' + componentLines.join('\n'),
    );
  }

  const componentCoverage = buildComponentDetailCoverageSection(catalog);
  if (componentCoverage) parts.push(componentCoverage);

  const colorTokens = spec.designSystem.colorTokens;
  if (typeof colorTokens === 'string' && colorTokens.trim()) {
    parts.push(
      '### MaxView Design Tokens — colors (REQUIRED)\n\n' +
        'Use ONLY the colors defined below. Pick by semantic role (e.g. `error.main` for errors, ' +
        '`primary.main` for primary actions). NEVER invent hex or rgba values not listed here.\n\n' +
        colorTokens,
    );
  }

  return `## MaxView Application Context\n\n${parts.join('\n\n')}\n\n---\n\n`;
}

function buildScreensContextSection(
  spec: AiRunV2VisualSpecification,
  appName = 'MaxView',
): string {
  const lines = asScreens(spec.designSystem.screenInventory)
    .filter((screen) => screen.route)
    .map((screen) => {
      let line = `- \`${screen.route}\``;
      if (screen.purpose) line += ` — ${screen.purpose}`;
      if (screen.userTypes?.length) line += ` [users: ${screen.userTypes.join(', ')}]`;
      if (screen.states) line += ` [states: ${screen.states}]`;
      return line;
    });

  if (lines.length === 0) return '';

  return (
    `### Existing ${appName} screens — inventory (route — purpose — user types — states)\n\n` +
    `Use this to understand which personas each screen serves and the UI states it supports.\n\n` +
    lines.join('\n') +
    '\n\n---\n\n'
  );
}

/**
 * Repository source the App Service read on the worker's behalf. A worker has
 * no checkout and no repository credentials, so if it is not here the model
 * cannot see it.
 */
export function buildPrototypeContextSection(
  spec: AiRunV2VisualSpecification,
): string {
  return [
    buildCatalogSection(spec),
    buildScreensContextSection(spec),
    buildPrototypeSourceSection(
      asSourceFiles(spec.promptInputs.sourceFiles),
      asPaths(spec.promptInputs.omittedSourcePaths),
    ),
  ].join('');
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The full prototype prompt, ported from `bedrockService` line-for-line.
 *
 * `planSection`, `pbiSection`, and `scopingSection` are derived from backlog
 * and design-plan rows, so App Service resolves them into `promptInputs`; the
 * instruction text below is static and belongs with the worker that uses it.
 */
export function buildPrototypePrompt(spec: AiRunV2VisualSpecification): string {
  const featureName = asText(spec.promptInputs.featureName);
  const featureDescription = asText(spec.promptInputs.featureDescription);
  const planSection = asText(spec.promptInputs.planSection);
  const pbiSection = asText(spec.promptInputs.pbiSection);
  const scopingSection = asText(spec.promptInputs.scopingSection);

  return `You are a senior UI/UX designer generating a high-fidelity HTML prototype for a MaxView application feature.

${buildPrototypeContextSection(spec)}
## Feature to Design

**Feature:** ${featureName}
${featureDescription ? `**Description:** ${featureDescription}` : ''}

${planSection}## PBI Requirements

${pbiSection}

## Instructions

Generate a single, self-contained HTML document with inline CSS and inline JavaScript (no external dependencies). The document must show **four state sections** stacked vertically, each clearly separated.

### Color usage — STRICT (the MaxView Design Tokens are the ONLY color source)

- Use ONLY the colors from the "MaxView Design Tokens — colors" section above, chosen by **semantic role** (e.g. \`primary.main\` for primary actions, \`error.main\` for errors, \`success.main\` for success, \`warning.main\` for warnings, \`info.main\` for info, \`text.primary\`/\`text.secondary\` for text, \`background.paper\` for cards, \`ui.divider\` for borders/dividers).
- **NEVER invent, approximate, or sample** any hex/rgba value that is not listed in those tokens.
- The reference screenshot is provided for **layout and structure only** — do NOT pick colors from it. If its colors differ from the tokens, the tokens win.
- When reproducing existing page code that contains literal color values, **map each one to the nearest semantic token** instead of copying the raw value.
- The single exception is the dashed "NEW" annotation marker described below, which intentionally uses \`tertiary.main\` (#a46bff) so it stands out as a review-only overlay.

${scopingSection}

### Visual annotation of the new feature — PRECISE SCOPING

The purple annotation border MUST wrap ONLY the specific new UI element(s) being added — NOT the entire page, NOT the entire content area, NOT the existing page shell. Examples of correct annotation scoping:
- If adding a new **column** to an existing table/grid → wrap ONLY that column (header cell + data cells), not the entire table.
- If adding a new **tab** to an existing tab bar → wrap ONLY the new tab header and its tab content panel, not all existing tabs.
- If adding a new **section/panel** to an existing page → wrap ONLY that new section, not the surrounding existing sections.
- If adding a new **button or control** to an existing toolbar → wrap ONLY that button, not the entire toolbar.
- If adding a new **drawer/modal** → wrap ONLY the drawer/modal overlay, not the page behind it.

Apply a **2px dashed #a46bff border** (MaxView \`tertiary.main\`) with 8px padding around ONLY the new element(s). Add a small floating label at the top-left corner reading "NEW: ${featureName}" styled with background #a46bff, white text, 10px bold font, 2px 6px padding, positioned so it overlaps the top border edge.

**The existing page content (sidebar, header, existing grids, existing tabs, existing forms) MUST NOT be inside the purple border.** The border exists solely to help reviewers instantly identify what is new vs what already exists.

Additionally, wrap ALL new feature HTML content in comment markers:
\`<!-- NEW_FEATURE:START -->\` immediately before the first new element and \`<!-- NEW_FEATURE:END -->\` immediately after the last.
These markers must appear inside each state section that contains new feature content (at minimum inside the DEFAULT and ERROR states). Place them just inside the purple annotation border so they enclose exactly the same content the border visually highlights.

### State sections

1. **DEFAULT STATE** — Full page shell (sidebar nav + header) + the annotated new feature area populated with realistic sample data. All PBI requirements must be visually represented.

2. **ERROR STATE** — Render ONLY a minimal representation of the new feature area showing its error states: inline validation errors, field-level red borders, and/or an error banner. Wrap this inside the state comments.

### Per-persona behavior variants

When a PBI lists a **Per-persona behavior** block (a control that behaves differently per persona group, e.g. Timecards button: S/I/C → behavior A; E/CO → behavior B), render that control **once per behavior group** within the annotated new feature area — each variant clearly labeled with the user types it applies to (e.g. a small role chip or persona tab such as "S, I, C" / "E, CO" next to or above each variant). Do NOT collapse divergent behaviors into a single control. Apply this within the DEFAULT state at minimum; the other states can show a single representative variant.

### Interactivity — lightweight inline JavaScript

Within each state section, add small UI interactions using vanilla JavaScript (no frameworks, no external scripts). These make the prototype feel realistic during review:
- **Dropdowns / select menus**: clicking opens a styled list; clicking an option selects it and closes the list.
- **Tabs**: clicking a tab switches the visible content panel below it.
- **Accordions / expandable sections**: clicking a header toggles content visibility with a chevron rotation.
- **Date pickers / calendars**: clicking a date input shows a simple month grid; clicking a date fills the input.
- **Modals / dialogs**: clicking trigger buttons (e.g. "Add Task", "Create") opens a styled overlay with form fields and Close/Cancel buttons that dismiss it.
- **Checkboxes / toggles**: clicking toggles checked/active state visually.
- **Hover effects**: use CSS :hover for button highlights, row highlights, card elevation.
- **Sidebar nav**: clicking a nav item highlights it as active (but does NOT navigate away).

Rules:
- All JavaScript must be inline in a single \`<script>\` tag at the end of \`<body>\`.
- NEVER use \`fetch\`, \`XMLHttpRequest\`, \`window.open\`, \`window.location\`, or any network/navigation calls.
- NEVER add \`<a href>\` links that navigate away. Use \`href="#"\` with \`event.preventDefault()\`.
- Keep interactions purely visual and local — no data persistence, no API calls.

### Icons and images rule — NO emojis, NO external images

The prototype must be fully self-contained. Follow these rules strictly:
- **NEVER** use emoji characters (🔔 📭 ✅ ⚠️ ⏳ etc.) anywhere in the prototype — not in nav items, buttons, headings, section headers, badges, or content.
- **NEVER** use \`<img>\` tags with external URLs or placeholder services (unsplash, placeholder.com, picsum, etc.).
- **ALL icons** must be inline SVGs using Material Icons paths (24×24 viewBox, \`fill="currentColor"\`). Examples:
  - Dashboard: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>\`
  - Checkmark: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>\`
  - Warning: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>\`
  - Error: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>\`
  - Add/Plus: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>\`
  - Search: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>\`
  - Person: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>\`
  - Notification: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>\`
- For user avatars, use a simple colored circle with initials, tinted with a MaxView token (e.g. \`<div style="width:32px;height:32px;border-radius:50%;background:#323695;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px">RT</div>\` — \`primary.main\` on \`primary.contrast\`).
- For section state headers, use a text label only with a colored dot or small inline SVG — NOT emoji.

### Section formatting

Each section must have:
- A sticky-positioned section header with label and a small colored indicator (NOT emoji), each using a MaxView token: "Default State" (\`success.main\` #39c164 dot), "Error State" (\`error.main\` #e43443 dot)
- A subtle background tint difference to separate sections visually
- Full MaxView design system styling throughout (sidebar, topbar, colors, typography)

### State section markers — REQUIRED (enables cheap per-state regeneration)

Wrap EACH of the two state sections with HTML comment delimiters EXACTLY as shown, so a single state can later be revised in isolation without re-emitting the whole document:
- \`<!-- STATE:default:START -->\` … the entire Default State section … \`<!-- STATE:default:END -->\`
- \`<!-- STATE:error:START -->\` … the entire Error State section … \`<!-- STATE:error:END -->\`

The START marker must be the first thing inside each state block and the END marker the last. Use the exact lowercase keys above. These markers must never be omitted or renamed.

Return ONLY the complete HTML document. No markdown fences, no explanation — just the raw HTML starting with <!DOCTYPE html>.`;
}

/**
 * The prototype prompt for a project that ships its own design system,
 * ported from `bedrockService.buildProjectPrototypePrompt`.
 *
 * It shares almost nothing with the MaxView prompt above — no catalog, no
 * palette, no sidebar, no Figma reference — and it can carry live web
 * references, which the MaxView branch never has. `appName`,
 * `designSystemMarkdown`, and the references are all resolved on App
 * Service: the design system lives in the project's own repository and the
 * search needs a key, so neither is a worker's to fetch.
 */
export function buildProjectPrototypePrompt(
  spec: DesignPrototypeVisualSpecification,
  branch: ProjectPrototypePrompt,
): string {
  const featureName = asText(spec.promptInputs.featureName);
  const featureDescription = asText(spec.promptInputs.featureDescription);
  const planSection = asText(spec.promptInputs.planSection);
  const pbiSection = asText(spec.promptInputs.pbiSection);
  const scopingSection = asText(spec.promptInputs.scopingSection);
  const { appName, designSystemMarkdown, extendMode } = branch;

  const webSection = branch.webReferences?.trim()
    ? `\n## Modern Design References (live web — inspiration only)\n\nThe following patterns were found via web research. Use them as **inspiration only** — they are **subordinate to the Design System** above. Apply the project's own tokens/components; do NOT copy off-brand colors, fonts, or layout structures from these references.\n\n${branch.webReferences}\n`
    : '';

  return `You are a world-class product designer generating a **market-quality, production-ready** HTML prototype for a feature of the **${appName}** application. This prototype should look like something a Series A SaaS startup would actually ship — not a wireframe, not a developer mockup. Reference companies like Linear, Loom, Vercel, Retool, or Rippling for the quality bar.

## ${appName} Design System (AUTHORITATIVE — sole design and color source)

${designSystemMarkdown}

## Feature to Design

**Feature:** ${featureName}
${featureDescription ? `**Description:** ${featureDescription}` : ''}

${planSection}## PBI Requirements

${pbiSection}
${webSection}
## Instructions

Generate a single, self-contained HTML document with inline CSS and inline JavaScript (no external dependencies). The document must show **four state sections** stacked vertically, each clearly separated.

### Design token usage — STRICT (the ${appName} Design System above is the ONLY color and style source)

- Use ONLY the colors and tokens defined in the Design System section above, referencing them by their CSS variable names or semantic roles.
- **NEVER invent, approximate, or sample** any hex/rgba value not listed in the Design System.
- When a :root block is provided, define those variables in your document's :root and reference them throughout.
- All fonts, spacing, radius, and shadows must follow the Design System values.

${scopingSection}

${extendMode ? '' : `### Visual annotation of the new feature — PRECISE SCOPING

Apply a **2px dashed annotation border** using the project's primary color with 8px padding around ONLY the new element(s). Add a small floating label at the top-left corner reading "NEW: ${featureName}". Wrap ALL new feature HTML content in:
\`<!-- NEW_FEATURE:START -->\` immediately before the first new element and \`<!-- NEW_FEATURE:END -->\` immediately after the last.

`}### State sections — FOUR REQUIRED, STACKED VERTICALLY

Stack all four state sections from top to bottom in the HTML. Do NOT hide any section — the reviewer scrolls through all four. Each section must have a sticky section header with a colored dot indicator and a subtle background tint so sections are visually distinct.

Wrap each section in these exact comment markers:

\`<!-- STATE:DEFAULT:START -->\` … default / populated state … \`<!-- STATE:DEFAULT:END -->\`
\`<!-- STATE:EMPTY:START -->\` … empty / zero-data state … \`<!-- STATE:EMPTY:END -->\`
\`<!-- STATE:ERROR:START -->\` … error / failure state … \`<!-- STATE:ERROR:END -->\`
\`<!-- STATE:LOADING:START -->\` … skeleton / spinner state … \`<!-- STATE:LOADING:END -->\`

Section header style for each:
- **DEFAULT** — label "Default State", green dot (#16a34a)
- **EMPTY** — label "Empty State", gray dot (#64748b)
- **ERROR** — label "Error State", red dot (#dc2626)
- **LOADING** — label "Loading State", blue dot (#3b82f6)

Do NOT use JavaScript to hide/show states. All four sections are always visible and the reviewer scrolls between them.

### Self-contained HTML rules — STRICTLY ENFORCED

- **ALL CSS** in a single \`<style>\` block in \`<head>\`. **ALL JS** in a single \`<script>\` at end of \`<body>\`.
- **NO** \`<link>\`, \`<base>\`, \`<meta http-equiv>\` tags.
- **NO** external \`src\`/\`href\` (http/https), \`url(https://…)\`, web fonts, CDN, or external images.
- **NO** network calls: \`fetch\`, \`XMLHttpRequest\`, \`window.open\`, \`window.location\` are banned.
- \`<a href>\` must be \`href="#"\` with \`event.preventDefault()\`.
- For icons, use inline SVGs (Material Icons style, 24×24 viewBox, \`fill="currentColor"\`). No emoji.
- For images/avatars, use colored circles with initials. No external image sources.

### Interactivity — lightweight inline JavaScript

Add inline JavaScript for: dropdowns, tabs, accordions, modals/dialogs, checkboxes/toggles, date pickers (simple month grid), hover effects (CSS :hover).

Return ONLY the complete HTML document. No markdown fences, no explanation — just the raw HTML starting with <!DOCTYPE html>.`;
}
