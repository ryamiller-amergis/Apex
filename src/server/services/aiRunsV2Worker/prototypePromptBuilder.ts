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
import type { AiRunV2VisualSpecification } from '../../../shared/types/aiRunV2VisualSpec';

type CatalogRoute = Readonly<{ path: string; title: string }>;

type SpecCatalog = Readonly<{
  routes?: ReadonlyArray<CatalogRoute>;
  componentNames?: ReadonlyArray<string>;
  componentDescriptions?: Record<string, string>;
  routeLayoutHints?: Record<string, string>;
  uiKnowledgeBase?: string;
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
function buildSourceSection(spec: AiRunV2VisualSpecification): string {
  const files = asSourceFiles(spec.promptInputs.sourceFiles);
  if (files.length === 0) return '';

  const blocks = files
    .map((file) => `#### ${file.path}\n\n\`\`\`tsx\n${file.content}\n\`\`\``)
    .join('\n\n');

  const omitted = asPaths(spec.promptInputs.omittedSourcePaths);
  const omittedNote =
    omitted.length > 0
      ? `\n\nThese files were omitted to stay within the context budget, so do not assume anything about them:\n\n${omitted
          .map((path) => `- \`${path}\``)
          .join('\n')}`
      : '';

  return `### Repository source for the affected surface\n\n${blocks}${omittedNote}\n\n---\n\n`;
}

export function buildPrototypeContextSection(
  spec: AiRunV2VisualSpecification,
): string {
  return [
    buildCatalogSection(spec),
    buildScreensContextSection(spec),
    buildSourceSection(spec),
  ].join('');
}
