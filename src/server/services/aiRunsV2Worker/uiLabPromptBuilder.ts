/**
 * Builds the UI Lab prompt from the execution specification alone.
 *
 * Ported from `uiLabBedrockService.buildContextSection` and
 * `buildGenerationPrompt`, which read the skill bundle, the palette, the
 * design-system catalog, the screen inventory, and the existing page source
 * inline. Wording is kept identical so moving the work to a worker changes
 * only where the inputs come from, not what the model is asked for.
 *
 * Regeneration (`buildEditPrompt`) is deliberately not here: the V2 visual
 * lane admits initial generation only, the same boundary the prototype lane
 * draws.
 */
import type {
  AiRunV2VisualSpecification,
  UiLabDesignSystemName,
} from '../../../shared/types/aiRunV2VisualSpec';

type SpecCatalog = Readonly<{
  /**
   * `PageRoute` objects upstream. Typed loosely because the in-process prompt
   * joins them straight into text — see `buildMaxviewCatalogSection`.
   */
  routes?: ReadonlyArray<unknown>;
  tokensCss?: string;
  componentNames?: ReadonlyArray<string>;
  componentDescriptions?: Record<string, string>;
  uiKnowledgeBase?: string;
}>;

type SpecScreen = Readonly<{
  route: string;
  purpose?: string;
  userTypes?: ReadonlyArray<string>;
}>;

export type ResolvedUiLabPromptInput = Readonly<{
  userPrompt: string;
  targetRoute: string | null;
  designSystemName: UiLabDesignSystemName;
  skillMarkdown: string;
  componentIndex: string;
  existingPageContext: string;
  catalog?: unknown;
  screenInventory?: unknown;
  colorTokens?: unknown;
}>;

const SCREEN_INVENTORY_ROW_CAP = 30;
const COMPONENT_NAME_CAP = 50;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asCatalog(value: unknown): SpecCatalog {
  return (value ?? {}) as SpecCatalog;
}

function formatApplicationRoute(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return String(value);
  }
  const route = value as Record<string, unknown>;
  if (typeof route.path !== 'string' || !route.path.trim()) {
    return String(value);
  }
  const title =
    typeof route.title === 'string' && route.title.trim()
      ? ` — ${route.title.trim()}`
      : '';
  return `- **${route.path.trim()}**${title}`;
}

function asScreens(value: unknown): ReadonlyArray<SpecScreen> {
  return Array.isArray(value) ? (value as SpecScreen[]) : [];
}

/** `MaxView` unless the specification names APEX, matching `isApexProject`. */
export function uiLabDesignSystemName(
  spec: AiRunV2VisualSpecification,
): UiLabDesignSystemName {
  return asText(spec.promptInputs.designSystemName) === 'APEX' ? 'APEX' : 'MaxView';
}

function buildMaxviewCatalogSection(catalog: SpecCatalog): string {
  const ctxParts: string[] = [];

  if (catalog.uiKnowledgeBase?.trim()) {
    ctxParts.push(
      `### Existing screens — detailed descriptions\n\n${catalog.uiKnowledgeBase.trim()}`,
    );
  }

  if (catalog.routes?.length) {
    ctxParts.push(
      `### Application routes\n\n${catalog.routes
        .map(formatApplicationRoute)
        .join('\n')}`,
    );
  }

  if (catalog.tokensCss?.trim()) {
    ctxParts.push(
      `### CSS custom properties (design tokens)\n\n\`\`\`css\n${catalog.tokensCss.trim()}\n\`\`\``,
    );
  }

  const compNames = (catalog.componentNames ?? []).slice(0, COMPONENT_NAME_CAP);
  if (compNames.length) {
    const compLines = compNames.map((name) => {
      const desc = catalog.componentDescriptions?.[name];
      return desc ? `- **${name}**: ${desc}` : `- ${name}`;
    });
    ctxParts.push(`### Available MaxView components\n\n${compLines.join('\n')}`);
  }

  return ctxParts.length
    ? `## MaxView Design System Catalog\n\n${ctxParts.join('\n\n')}`
    : '';
}

function normalizeRoute(route: string): string {
  return route.trim().toLowerCase().replace(/^\//, '').split(/[?#]/)[0];
}

function buildScreenInventorySection(
  inventoryValue: unknown,
  targetRoute: string,
): string {
  const inventory = asScreens(inventoryValue);
  if (inventory.length === 0) return '';

  // Keep the target route's row from being truncated by the 30-row cap by
  // ordering any rows matching the target route first.
  const normTarget = targetRoute ? normalizeRoute(targetRoute) : '';
  const isTarget = (r: SpecScreen): boolean =>
    normTarget.length > 0
    && r.route.split(',').some((seg) => normalizeRoute(seg).includes(normTarget));
  const ordered = normTarget
    ? [...inventory.filter(isTarget), ...inventory.filter((r) => !isTarget(r))]
    : inventory;
  const rows = ordered
    .slice(0, SCREEN_INVENTORY_ROW_CAP)
    .map(
      (r) =>
        `- **${r.route}** — ${r.purpose ?? ''}${
          r.userTypes?.length ? ` (${r.userTypes.join(', ')})` : ''
        }`,
    )
    .join('\n');

  return `## Screen Inventory (existing pages)\n\n${rows}`;
}

/**
 * EXTEND mode: the real source of the page being extended. App Service reads
 * it through `fetchExistingPageContext`, because a worker has no checkout and
 * no repository credentials.
 */
function buildExistingPageSection(
  pageContextValue: unknown,
  targetRoute: string,
): string {
  if (!targetRoute.trim()) return '';
  const pageContext = asText(pageContextValue);
  if (!pageContext.trim()) return '';

  return (
    `## Existing page source — extend this (ground truth)\n\n`
    + `The following is the real source of the page at \`${targetRoute}\` and its `
    + `relevant child components. Reproduce its actual layout, columns, controls, and `
    + `data shape, and add the requested new behavior INTO this structure — do not `
    + `invent a different layout or let the brief override the existing structure.\n\n`
    + pageContext.trim()
  );
}

function resolvedPromptInput(
  spec: AiRunV2VisualSpecification,
): ResolvedUiLabPromptInput {
  return {
    userPrompt: asText(spec.promptInputs.userPrompt),
    targetRoute: asText(spec.promptInputs.targetRoute) || null,
    designSystemName: uiLabDesignSystemName(spec),
    skillMarkdown: asText(spec.promptInputs.skillMarkdown),
    componentIndex: asText(spec.promptInputs.componentIndex),
    existingPageContext: asText(spec.promptInputs.existingPageContext),
    catalog: spec.designSystem.catalog,
    screenInventory: spec.designSystem.screenInventory,
    colorTokens: spec.designSystem.colorTokens,
  };
}

export function buildResolvedUiLabContextSection(
  input: ResolvedUiLabPromptInput,
): string {
  const parts: string[] = [];
  const forApex = input.designSystemName === 'APEX';
  const targetRoute = input.targetRoute ?? '';

  const skillMarkdown = input.skillMarkdown;
  if (skillMarkdown.trim()) {
    parts.push(`## UI Lab Design System Standards\n\n${skillMarkdown.trim()}`);
  }

  const colorTokens = asText(input.colorTokens);
  if (forApex) {
    // ── APEX project: APEX design tokens + component index ──────────────────
    if (colorTokens.trim()) {
      parts.push(`## APEX Color Tokens\n\n${colorTokens.trim()}`);
    }
    const componentIndex = input.componentIndex;
    if (componentIndex.trim()) {
      parts.push(`## APEX Component Index\n\n${componentIndex.trim()}`);
    }
  } else {
    // ── Default (MaxView and unconfigured) ──────────────────────────────────
    if (colorTokens.trim()) {
      parts.push(`## MaxView Color Tokens\n\n${colorTokens.trim()}`);
    }
    const catalogSection = buildMaxviewCatalogSection(
      asCatalog(input.catalog),
    );
    if (catalogSection) parts.push(catalogSection);
  }

  const inventorySection = buildScreenInventorySection(
    input.screenInventory,
    targetRoute,
  );
  if (inventorySection) parts.push(inventorySection);

  const existingPageSection = buildExistingPageSection(
    input.existingPageContext,
    targetRoute,
  );
  if (existingPageSection) parts.push(existingPageSection);

  return parts.join('\n\n---\n\n');
}

export function buildUiLabContextSection(
  spec: AiRunV2VisualSpecification,
): string {
  return buildResolvedUiLabContextSection(resolvedPromptInput(spec));
}

/**
 * The full UI Lab generation prompt, ported from `uiLabBedrockService`
 * line-for-line.
 *
 * The in-process builder also takes the Figma screenshot, but never reads it —
 * the image rides on the Bedrock message, not in the prompt text. It is left
 * out here for the same reason: it travels on `designReference` and
 * `visualEntrypoint` attaches it to the call.
 */
export function buildResolvedUiLabPrompt(
  input: ResolvedUiLabPromptInput,
): string {
  const userPrompt = input.userPrompt;
  const targetRoute = input.targetRoute ?? '';
  const dsName = input.designSystemName;
  const contextSection = buildResolvedUiLabContextSection(input);

  const routeClause = targetRoute
    ? `The UI should be designed for the route: \`${targetRoute}\`. Study the existing page context from the design system catalog and match the surrounding layout/navigation shell.`
    : 'This is a standalone new UI — design an appropriate layout and navigation shell.';

  const fontInstruction = dsName === 'APEX'
    ? '- Use the system font stack defined by the APEX design system (no external font import required).'
    : '- Use Roboto font: add `<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">` in <head>.';

  return `You are an expert UI/UX designer and front-end engineer specializing in the ${dsName} design system. Generate a complete, self-contained, interactive HTML prototype that exactly follows the ${dsName} design system tokens, spacing, typography, and component usage rules defined below.

${contextSection}

---

## Your task

${userPrompt}

${routeClause}

---

## Critical output requirements

### 1. Design system fidelity
- Use ONLY color values from the ${dsName} Color Tokens above — no invented hex values.
- Use ONLY the spacing scale (multiples of 4px, base 8px grid).
${fontInstruction}
- Follow the component usage rules exactly (button variants, form patterns, elevation).

### 2. Four required UI states
Include all four states with these exact HTML comment markers:

\`\`\`
<!-- STATE:DEFAULT:START -->
  ... fully populated/interactive default state ...
<!-- STATE:DEFAULT:END -->

<!-- STATE:EMPTY:START -->
  ... empty/zero-data state with helpful message and CTA ...
<!-- STATE:EMPTY:END -->

<!-- STATE:ERROR:START -->
  ... error/failure state with message and retry action ...
<!-- STATE:ERROR:END -->

<!-- STATE:LOADING:START -->
  ... skeleton/spinner loading state ...
<!-- STATE:LOADING:END -->
\`\`\`

Only DEFAULT is visible on load. Include a small state-switcher control (top-right, subtle) to toggle between states for review.

### 3. Self-contained HTML
- One complete <html> document.
- All CSS inline in <style> tags — no external CSS imports except Google Fonts.
- All JS inline in <script> tags — no external JS (no React, no framework).
- No calls to external APIs, no fetch(), no XMLHttpRequest.
- Fully functional interactive prototype: clicks, hovers, form interactions work.
- Responsive: mobile-first, works at 375px and 1440px width.

### 4. Realistic content
- Use realistic, plausible placeholder content (not "Lorem ipsum").
- Use realistic user names, dates, data values appropriate to the described feature.

### 5. Accessibility baseline
- All images have non-empty alt attributes.
- All icon-only buttons have aria-label.
- Form inputs have associated labels.
- Focus ring visible on all interactive elements.

---

Output ONLY the complete HTML — no markdown fences, no explanation, no preamble. Start with \`<!DOCTYPE html>\` and end with \`</html>\`.`;
}

export function buildUiLabPrompt(spec: AiRunV2VisualSpecification): string {
  return buildResolvedUiLabPrompt(resolvedPromptInput(spec));
}
