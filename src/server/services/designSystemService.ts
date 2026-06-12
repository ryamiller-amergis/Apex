/**
 * Fetches a lightweight design-system catalog from the MaxView ADO repository:
 *   - Page routes (React Router routes scraped from App.tsx / routes file)
 *   - CSS design tokens (custom properties from App.css / variables)
 *   - Component index (names + descriptions from src/components)
 *   - Component descriptions (leading JSDoc from each .tsx file, max 200 chars)
 *   - Route layout hints (heuristic layout pattern per route, e.g. "table", "calendar")
 *
 * Results are cached for CATALOG_TTL_MS (10 minutes) so repeated backlog-mock
 * requests don't hammer ADO.
 */

import https from 'https';
import type { ScreenInventoryRoute } from '../../shared/types/designSystem';

/* ── Config ───────────────────────────────────────────────── */

const DS_REPO    = process.env.MAXVIEW_DS_REPO    ?? 'MaxView';
const DS_PROJECT = process.env.MAXVIEW_DS_PROJECT ?? 'MaxView';
const CATALOG_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Repo-relative root for the app's component tree. The screen inventory lists
 * "Component / File" paths relative to this root (e.g. MaxView lists `components/…`
 * relative to `src/Maxim.TimeClock.Web/ClientApp/js`). Set MAXVIEW_CLIENTAPP_ROOT so those
 * relative tokens — and the relative imports followed from them — resolve to real ADO paths.
 * Empty by default: tokens are then treated as repo-root-relative (back-compat).
 * Read live so the value can be configured without a restart and overridden in tests.
 */
function clientAppRoot(): string {
  return (process.env.MAXVIEW_CLIENTAPP_ROOT ?? '').trim().replace(/\/+$/, '');
}

/** Path to the UI knowledge base that describes each existing MaxView screen. */
const UI_KNOWLEDGE_BASE_PATH = '/.cursor/skills/figma-ui-knowledge-base/SKILL.md';

/** Inventory table (Route → Component/File → Purpose → …) for every ClientApp page. */
const SCREENS_INVENTORY_PATH = '/.cursor/skills/figma-ui-knowledge-base/clientapp-screens.md';

/** Combined byte cap for an extracted existing-page context block (page + child components). */
const MAX_PAGE_CONTEXT_BYTES = 48 * 1024;

/**
 * Maximum import depth followed when extracting existing-page context. Depth 0 is the page
 * file, depth 1 its direct imports (always included), and depth >= 2 imports are only
 * followed when their component name matches the feature keywords (keeps token cost bounded).
 */
const MAX_PAGE_CONTEXT_DEPTH = 3;

/** TTL for cached per-route page context. */
const PAGE_CONTEXT_TTL_MS = 10 * 60 * 1000;

/** Candidate paths tried in order; first non-empty wins. */
const ROUTE_PATHS = [
  '/src/client/App.tsx',
  '/src/App.tsx',
  '/App.tsx',
];

const TOKEN_PATHS = [
  '/src/client/App.css',
  '/src/client/index.css',
  '/src/App.css',
  '/src/index.css',
];

/** Folders searched (in order) to locate a component by name. Includes the ClientApp root when set. */
function componentIndexPaths(): string[] {
  const root = clientAppRoot();
  return [
    ...(root ? [`${root}/components`] : []),
    '/src/client/components',
    '/src/components',
  ];
}

/* ── Types ────────────────────────────────────────────────── */

export interface PageRoute {
  path: string;
  title: string;
}

export interface DesignSystemCatalog {
  routes: PageRoute[];
  tokensCss: string;        // raw CSS :root block(s)
  componentNames: string[]; // e.g. ["ScrumCalendar", "BacklogView", …]
  /** Raw markdown from /.cursor/skills/figma-ui-knowledge-base/SKILL.md describing each existing screen */
  uiKnowledgeBase: string;
  /** Short descriptions extracted from each component's leading JSDoc comment (≤ 200 chars each). */
  componentDescriptions: Record<string, string>;
  /** Heuristic layout pattern per route, e.g. { "/shift-scheduler": "calendar", "/timecards": "table" } */
  routeLayoutHints: Record<string, string>;
  fetchedAt: number;
}

/* ── Cache ────────────────────────────────────────────────── */

let catalogCache: DesignSystemCatalog | null = null;

/* ── ADO file fetch helper ────────────────────────────────── */

function fetchAdoFile(orgUrl: string, pat: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${pat}`).toString('base64');
    const encodedPath = encodeURIComponent(path);
    const apiUrl = new URL(
      `${orgUrl}/${DS_PROJECT}/_apis/git/repositories/${DS_REPO}/items?path=${encodedPath}&api-version=7.1&$format=text`
    );
    const options: https.RequestOptions = {
      hostname: apiUrl.hostname,
      path: apiUrl.pathname + apiUrl.search,
      method: 'GET',
      headers: { Authorization: `Basic ${token}`, Accept: 'text/plain' },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`ADO ${res.statusCode} for ${path}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error(`Timeout: ${path}`)); });
    req.end();
  });
}

/** Fetch ADO git tree listing for a folder path (returns item paths). */
function fetchAdoTree(
  orgUrl: string,
  pat: string,
  folderPath: string,
  recursionLevel: 'OneLevel' | 'Full' = 'OneLevel',
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${pat}`).toString('base64');
    const encodedPath = encodeURIComponent(folderPath);
    const apiUrl = new URL(
      `${orgUrl}/${DS_PROJECT}/_apis/git/repositories/${DS_REPO}/items?path=${encodedPath}&recursionLevel=${recursionLevel}&api-version=7.1`
    );
    const options: https.RequestOptions = {
      hostname: apiUrl.hostname,
      path: apiUrl.pathname + apiUrl.search,
      method: 'GET',
      headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data) as { value?: Array<{ path: string }> };
            resolve((json.value ?? []).map(i => i.path));
          } catch {
            resolve([]);
          }
        } else {
          reject(new Error(`ADO tree ${res.statusCode} for ${folderPath}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error(`Timeout tree: ${folderPath}`)); });
    req.end();
  });
}

/* ── Parsers ──────────────────────────────────────────────── */

/**
 * Extract React Router <Route path="…"> entries from App.tsx source.
 * Also picks up navigate('/foo') and pathname.startsWith('/foo') patterns
 * to capture dynamic navigation targets.
 */
function parseRoutes(src: string): PageRoute[] {
  const routes: PageRoute[] = [];
  const seen = new Set<string>();

  const add = (path: string, title: string) => {
    if (!seen.has(path)) { seen.add(path); routes.push({ path, title }); }
  };

  // pathname.startsWith('/foo') or pathname === '/foo'
  for (const m of src.matchAll(/pathname(?:\.startsWith\(['"])?(\/[^'")\s]+)/g)) {
    add(m[1], m[1]);
  }

  // navigate('/foo')
  for (const m of src.matchAll(/navigate\(['"](\/?[^'"]+)['"]\)/g)) {
    add(m[1], m[1]);
  }

  // <Route path="/foo" element={…} />  or  path: '/foo'
  for (const m of src.matchAll(/path[=:]\s*['"](\/?[^'"]+)['"]/g)) {
    add(m[1], m[1]);
  }

  // currentView string literals
  for (const m of src.matchAll(/currentView[^'"]*?['"](calendar|planning|cloudcost|backlog|[a-z-]+)['"]/g)) {
    add(`/${m[1]}`, m[1]);
  }

  return routes;
}

/**
 * Extract :root { --variable: value } blocks from CSS.
 * Truncates to 4 KB so the prompt stays manageable.
 */
function parseTokens(css: string): string {
  const matches: string[] = [];
  for (const m of css.matchAll(/:root\s*\{([^}]+)\}/g)) {
    matches.push(`:root {\n${m[1]}\n}`);
  }
  const joined = matches.join('\n\n');
  return joined.length > 4096 ? joined.slice(0, 4096) + '\n/* …truncated… */' : joined;
}

/**
 * Resolve a relative path against a base ADO file path.
 * e.g. base = "/.cursor/skills/figma-ui-knowledge-base/SKILL.md"
 *      ref  = "./screens/document-manager.md"
 *      →     "/.cursor/skills/figma-ui-knowledge-base/screens/document-manager.md"
 */
function resolveAdoPath(basePath: string, ref: string): string {
  // External URLs are not ADO paths — skip them
  if (/^https?:\/\//.test(ref)) return '';

  const baseDir = basePath.substring(0, basePath.lastIndexOf('/'));

  // Strip leading "./" for simplicity
  const clean = ref.startsWith('./') ? ref.slice(2) : ref;

  // Handle "../" traversal
  const parts = `${baseDir}/${clean}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') { resolved.pop(); }
    else if (part !== '.') { resolved.push(part); }
  }
  return resolved.join('/');
}

/**
 * Parse markdown for file references: [label](./relative-path.md)
 * Only returns refs that point to markdown files (.md / .mdx).
 * Ignores anchors (#section), external URLs, and non-markdown files.
 */
function parseMarkdownFileRefs(markdown: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)) {
    const href = m[2].split('#')[0].trim(); // strip anchor fragments
    if (!href || /^https?:\/\//.test(href)) continue;
    if (!href.endsWith('.md') && !href.endsWith('.mdx')) continue;
    if (!seen.has(href)) { seen.add(href); refs.push(href); }
  }
  return refs;
}

/**
 * Fetch the SKILL.md knowledge base plus any .md files it references inline.
 * Referenced file content is appended after the root file, separated by headers.
 * Depth is limited to 1 level — references within referenced files are not followed.
 */
async function fetchUiKnowledgeBase(orgUrl: string, pat: string): Promise<string> {
  let root = '';
  try {
    root = await fetchAdoFile(orgUrl, pat, UI_KNOWLEDGE_BASE_PATH);
  } catch (e: any) {
    console.warn(`[designSystemService] ui-knowledge-base: could not fetch ${UI_KNOWLEDGE_BASE_PATH} — ${e.message}`);
    return '';
  }

  const refs = parseMarkdownFileRefs(root);
  if (refs.length === 0) return root;

  // Fetch all referenced files in parallel; failures are non-fatal
  const fetched = await Promise.allSettled(
    refs.map(async (ref) => {
      const adoPath = resolveAdoPath(UI_KNOWLEDGE_BASE_PATH, ref);
      if (!adoPath) return null;
      const content = await fetchAdoFile(orgUrl, pat, adoPath);
      return { ref, adoPath, content };
    })
  );

  const sections: string[] = [root];
  for (const result of fetched) {
    if (result.status === 'fulfilled' && result.value?.content?.trim()) {
      const { adoPath, content } = result.value;
      const name = adoPath.split('/').pop() ?? adoPath;
      sections.push(`\n---\n<!-- ${name} -->\n\n${content.trim()}`);
      console.log(`[designSystemService] ui-knowledge-base: loaded referenced file ${adoPath}`);
    } else if (result.status === 'rejected') {
      console.warn(`[designSystemService] ui-knowledge-base: could not fetch referenced file — ${result.reason}`);
    }
  }

  return sections.join('\n');
}

/**
 * Convert ADO file paths under /src/client/components to component names.
 * e.g. "/src/client/components/BacklogView.tsx" → "BacklogView"
 */
function pathsToComponentNames(paths: string[]): string[] {
  return paths
    .filter(p => (p.endsWith('.tsx') || p.endsWith('.ts')) && !p.includes('.css') && !p.includes('__tests__') && !p.includes('.module.'))
    .map(p => {
      const base = p.split('/').pop() ?? p;
      return base.replace(/\.(tsx?|jsx?)$/, '');
    })
    .filter(n => n.length > 0 && /^[A-Z]/.test(n)); // exported components start with uppercase
}

/**
 * Extract the first JSDoc-style comment from a TypeScript source file.
 * Returns the comment text stripped of leading `* ` markers, truncated to 200 chars.
 */
function extractLeadingJsDoc(src: string): string {
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!m) return '';
  const text = m[1]
    .split('\n')
    .map(l => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

/**
 * Infer a rough layout pattern from a component file's source.
 * Returns one of the UiLayoutPattern string literals, or empty string when unknown.
 */
function inferLayoutPattern(src: string): string {
  if (/react-big-calendar|BigCalendar|FullCalendar|CalendarView/i.test(src)) return 'calendar';
  if (/<table|mwx-table-wrap|DataTable/i.test(src)) return 'table';
  if (/Dashboard|stat-value|grid-3|KpiCard/i.test(src)) return 'dashboard';
  if (/<form|useForm|FormField|\.form-row/i.test(src)) return 'form';
  if (/detail-layout|detail-main|detail-side/i.test(src)) return 'detail-page';
  if (/wizard|step-by-step|WizardStep/i.test(src)) return 'wizard';
  return '';
}

/**
 * Fetch component source files in parallel and extract descriptions + layout hints.
 * At most 20 files are fetched to stay within the ADO rate limit.
 */
async function fetchComponentDetails(
  orgUrl: string,
  pat: string,
  componentPaths: string[]
): Promise<{ descriptions: Record<string, string>; layoutHints: Record<string, string> }> {
  const descriptions: Record<string, string> = {};
  const layoutHints: Record<string, string> = {};

  // Filter to component .tsx files only and cap at 20
  const targets = componentPaths
    .filter(p => p.endsWith('.tsx') && !p.includes('__tests__') && !p.includes('.module.'))
    .slice(0, 20);

  const results = await Promise.allSettled(
    targets.map(p => fetchAdoFile(orgUrl, pat, p).then(src => ({ path: p, src })))
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { path, src } = result.value;
    const base = path.split('/').pop() ?? path;
    const name = base.replace(/\.tsx?$/, '');
    if (!name || !/^[A-Z]/.test(name)) continue;

    const desc = extractLeadingJsDoc(src);
    if (desc) descriptions[name] = desc;

    const layout = inferLayoutPattern(src);
    if (layout) layoutHints[name] = layout;
  }

  return { descriptions, layoutHints };
}

/**
 * Build route → layout hints by matching route paths to component names.
 * e.g. "/shift-scheduler" → component ScrumCalendar → "calendar"
 */
function buildRouteLayoutHints(
  routes: PageRoute[],
  componentLayoutHints: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const route of routes) {
    // Normalise the route path to a camelCase or PascalCase component name guess
    const slug = route.path.replace(/^\//, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const pascalSlug = slug.charAt(0).toUpperCase() + slug.slice(1);

    // Find a component whose name contains the slug (partial match)
    const matchingEntry = Object.entries(componentLayoutHints).find(([name]) =>
      name.toLowerCase().includes(slug.toLowerCase()) || name.toLowerCase().includes(pascalSlug.toLowerCase())
    );
    if (matchingEntry) {
      result[route.path] = matchingEntry[1];
    }
  }
  return result;
}

/* ── Main export ──────────────────────────────────────────── */

export async function getDesignSystemCatalog(): Promise<DesignSystemCatalog> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }

  const orgUrl = process.env.ADO_ORG;
  const pat    = process.env.ADO_PAT;

  if (!orgUrl || !pat) {
    console.warn('[designSystemService] ADO_ORG or ADO_PAT not set — returning empty catalog');
    return { routes: [], tokensCss: '', componentNames: [], uiKnowledgeBase: '', componentDescriptions: {}, routeLayoutHints: {}, fetchedAt: now };
  }

  /* ── Routes ── */
  let routes: PageRoute[] = [];
  for (const p of ROUTE_PATHS) {
    try {
      const src = await fetchAdoFile(orgUrl, pat, p);
      if (src.trim()) { routes = parseRoutes(src); break; }
    } catch (e: any) {
      console.warn(`[designSystemService] routes: skipping ${p} — ${e.message}`);
    }
  }

  /* ── Tokens ── */
  let tokensCss = '';
  for (const p of TOKEN_PATHS) {
    try {
      const css = await fetchAdoFile(orgUrl, pat, p);
      if (css.trim()) { tokensCss = parseTokens(css); break; }
    } catch (e: any) {
      console.warn(`[designSystemService] tokens: skipping ${p} — ${e.message}`);
    }
  }

  /* ── Component names + descriptions + layout hints ── */
  let componentNames: string[] = [];
  let componentDescriptions: Record<string, string> = {};
  let componentLayoutHints: Record<string, string> = {};

  for (const folder of componentIndexPaths()) {
    try {
      const paths = await fetchAdoTree(orgUrl, pat, folder);
      componentNames = pathsToComponentNames(paths);
      if (componentNames.length > 0) {
        // Fetch source for component details (non-fatal)
        try {
          const componentFilePaths = paths.filter(
            p => p.endsWith('.tsx') && !p.includes('__tests__') && !p.includes('.module.')
          );
          const details = await fetchComponentDetails(orgUrl, pat, componentFilePaths);
          componentDescriptions = details.descriptions;
          componentLayoutHints = details.layoutHints;
        } catch (e: any) {
          console.warn(`[designSystemService] component details: skipping — ${e.message}`);
        }
        break;
      }
    } catch (e: any) {
      console.warn(`[designSystemService] components: skipping ${folder} — ${e.message}`);
    }
  }

  /* ── Route layout hints (derived from component layout hints) ── */
  const routeLayoutHints = buildRouteLayoutHints(routes, componentLayoutHints);

  /* ── UI Knowledge Base (SKILL.md + any referenced .md files) ── */
  const uiKnowledgeBase = await fetchUiKnowledgeBase(orgUrl, pat);

  const catalog: DesignSystemCatalog = {
    routes,
    tokensCss,
    componentNames,
    uiKnowledgeBase,
    componentDescriptions,
    routeLayoutHints,
    fetchedAt: now,
  };
  catalogCache = catalog;

  console.log(
    `[designSystemService] Catalog loaded — ${routes.length} routes, ${componentNames.length} components, ` +
    `${Object.keys(componentDescriptions).length} descriptions, ${Object.keys(routeLayoutHints).length} layout hints, ` +
    `${tokensCss.length} chars of tokens, ui-kb: ${uiKnowledgeBase.length} chars`
  );

  return catalog;
}

/* ── Existing-page context (EXTEND mode) ──────────────────── */

interface PageContextCacheEntry {
  context: string;
  fetchedAt: number;
}

const pageContextCache = new Map<string, PageContextCacheEntry>();

/** Strip backtick/bold/link markdown decoration from a table cell. */
function stripMarkdownCell(cell: string): string {
  return cell
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

/** Normalise a route for comparison (drop trailing slash, query, anchor, case). */
function normaliseRoute(route: string): string {
  let r = route.trim().split(/[?#]/)[0].toLowerCase();
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  if (r && !r.startsWith('/')) r = `/${r}`;
  return r;
}

function routesEqual(a: string, b: string): boolean {
  const na = normaliseRoute(a);
  const nb = normaliseRoute(b);
  if (na === nb) return true;
  // Tolerate param segments: "/document/:id" vs "/document/123" → compare base.
  const baseA = na.split('/:')[0];
  const baseB = nb.split('/:')[0];
  return baseA.length > 1 && baseA === baseB;
}

interface ParsedScreenRow {
  route: string;
  file: string;
  purpose: string;
  userTypes?: string[];
  states?: string;
  keyComponents?: string[];
}

/** Split a "Key components" cell into component-name tokens (commas / slashes), stripping backticks. */
function parseKeyComponentsCell(cell: string): string[] {
  return stripMarkdownCell(cell)
    .split(/[,/]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Split a "User types" cell into trimmed persona slugs (commas / slashes / spaces). */
function parseUserTypesCell(cell: string): string[] {
  return stripMarkdownCell(cell)
    .split(/[,/\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Parse the clientapp-screens.md inventory table into screen rows.
 * Detects the header row to locate the Route, Component/File, and Purpose columns, and
 * (when present) the optional "User types"/personas and "States" columns.
 */
function parseScreenInventory(markdown: string): ParsedScreenRow[] {
  const rows: ParsedScreenRow[] = [];
  let routeIdx = -1;
  let fileIdx = -1;
  let purposeIdx = -1;
  let userTypesIdx = -1;
  let statesIdx = -1;
  let keyComponentsIdx = -1;

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length === 0) continue;

    if (routeIdx === -1) {
      const lower = cells.map(c => c.toLowerCase());
      const ri = lower.findIndex(c => c.includes('route'));
      const fi = lower.findIndex(c => c.includes('component') || c.includes('file'));
      if (ri >= 0 && fi >= 0) {
        routeIdx = ri;
        fileIdx = fi;
        purposeIdx = lower.findIndex(c => c.includes('purpose') || c.includes('description'));
        userTypesIdx = lower.findIndex(c => c.includes('user type') || c.includes('persona'));
        statesIdx = lower.findIndex(c => c.includes('state'));
        // "Key components" — avoid colliding with the "Component / File" column.
        keyComponentsIdx = lower.findIndex((c, i) => i !== fileIdx && c.includes('key component'));
      }
      continue;
    }

    // Skip the header separator row (e.g. | --- | --- |).
    if (cells.every(c => /^:?-+:?$/.test(c) || c === '')) continue;

    const route = stripMarkdownCell(cells[routeIdx] ?? '');
    const file = stripMarkdownCell(cells[fileIdx] ?? '');
    const purpose = purposeIdx >= 0 ? stripMarkdownCell(cells[purposeIdx] ?? '') : '';
    if (!route) continue;

    const row: ParsedScreenRow = { route, file, purpose };

    if (userTypesIdx >= 0) {
      const userTypes = parseUserTypesCell(cells[userTypesIdx] ?? '');
      if (userTypes.length > 0) row.userTypes = userTypes;
    }
    if (statesIdx >= 0) {
      const states = stripMarkdownCell(cells[statesIdx] ?? '');
      if (states) row.states = states;
    }
    if (keyComponentsIdx >= 0) {
      const keyComponents = parseKeyComponentsCell(cells[keyComponentsIdx] ?? '');
      if (keyComponents.length > 0) row.keyComponents = keyComponents;
    }

    rows.push(row);
  }

  return rows;
}

/**
 * Root a (possibly relative) inventory "Component / File" token under CLIENTAPP_ROOT.
 * Absolute tokens (already starting with "/") are returned unchanged.
 */
function rootClientAppPath(token: string): string {
  if (token.startsWith('/')) return token;
  const clean = token.replace(/^\.?\//, '');
  const root = clientAppRoot();
  return root ? `${root}/${clean}` : `/${clean}`;
}

/** Extract a source filename/path token from an inventory "Component / File" cell. */
function extractFileToken(cell: string): string {
  const m = cell.match(/([\w./-]+\.(?:tsx|ts|jsx|js))/);
  if (m) return m[1];
  // Otherwise treat the first PascalCase word as a component name.
  const c = cell.match(/\b([A-Z][A-Za-z0-9]+)\b/);
  return c ? c[1] : '';
}

/** Try fetching a source file, attempting common extensions when none is given. */
async function fetchSourceWithExtensions(
  orgUrl: string,
  pat: string,
  pathNoExt: string,
): Promise<{ path: string; src: string } | null> {
  // Try .ts/.tsx first, then .js/.jsx so resolution works for both TypeScript apps
  // and JavaScript apps (e.g. MaxView's ClientApp is predominantly .js/.jsx).
  const candidates = /\.(tsx?|jsx?)$/.test(pathNoExt)
    ? [pathNoExt]
    : [
        `${pathNoExt}.tsx`, `${pathNoExt}.ts`, `${pathNoExt}.jsx`, `${pathNoExt}.js`,
        `${pathNoExt}/index.tsx`, `${pathNoExt}/index.ts`, `${pathNoExt}/index.jsx`, `${pathNoExt}/index.js`,
      ];

  for (const candidate of candidates) {
    try {
      const src = await fetchAdoFile(orgUrl, pat, candidate);
      if (src.trim()) return { path: candidate, src };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Locate a component file by basename or component name across the component trees. */
async function findComponentPath(orgUrl: string, pat: string, token: string): Promise<string | null> {
  // Match on the basename without extension so we resolve a component regardless of
  // whether it ships as .tsx/.ts/.jsx/.js (MaxView's ClientApp uses .js/.jsx).
  const rawBase = token.split('/').pop() ?? token;
  const wantStem = rawBase.replace(/\.(tsx?|jsx?)$/, '').toLowerCase();
  const exts = ['tsx', 'ts', 'jsx', 'js'];

  for (const folder of componentIndexPaths()) {
    try {
      const paths = await fetchAdoTree(orgUrl, pat, folder, 'Full');
      const hit = paths.find(p => exts.some(ext => p.toLowerCase().endsWith(`/${wantStem}.${ext}`)));
      if (hit) return hit;
    } catch (e: any) {
      console.warn(`[designSystemService] findComponentPath: tree ${folder} failed — ${e.message}`);
    }
  }
  return null;
}

/**
 * Resolve a route to a page component ADO path. Prefers the clientapp-screens.md
 * inventory (Route → Component/File); falls back to App.tsx routes / component folder.
 */
async function resolvePageFilePath(orgUrl: string, pat: string, route: string): Promise<string | null> {
  // 1) Inventory table lookup.
  try {
    const md = await fetchAdoFile(orgUrl, pat, SCREENS_INVENTORY_PATH);
    const match = parseScreenInventory(md).find(r => routesEqual(r.route, route));
    if (match?.file) {
      const token = extractFileToken(match.file);
      if (token) {
        if (token.includes('/')) {
          const direct = await fetchSourceWithExtensions(orgUrl, pat, rootClientAppPath(token));
          if (direct) return direct.path;
        }
        const located = await findComponentPath(orgUrl, pat, token);
        if (located) return located;
      }
    }
  } catch (e: any) {
    console.warn(`[designSystemService] fetchExistingPageContext: inventory lookup failed — ${e.message}`);
  }

  // 2) Fallback: derive a PascalCase component-name guess from the route slug.
  const slug = route.replace(/[?#].*$/, '').replace(/^\//, '').split('/')[0];
  if (slug) {
    const camel = slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
    for (const guess of [pascal, `${pascal}View`, `${pascal}Page`]) {
      const located = await findComponentPath(orgUrl, pat, guess);
      if (located) return located;
    }
  }

  return null;
}

/** Resolve relative import refs found in a page's source to ADO paths (no extension). */
function parseLocalImportRefs(src: string, basePath: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/import\s+[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
    const ref = m[1];
    if (!ref.startsWith('.')) continue;
    if (/\.(css|scss|less|json|svg|png)$/.test(ref)) continue;
    const resolved = resolveAdoPath(basePath, ref);
    if (resolved && !seen.has(resolved)) { seen.add(resolved); refs.push(resolved); }
  }
  return refs;
}

/** Distinctive feature keywords from free text (lowercased, >= 3 chars, stopwords removed). */
function extractKeywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of tokenize(text)) {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/** Name tokens for a file path or component name, camelCase-split and lowercased (>= 3 chars). */
function fileNameTokens(pathOrName: string): Set<string> {
  const base = (pathOrName.split('/').pop() ?? pathOrName).replace(/\.(tsx?|jsx?)$/, '');
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const out = new Set<string>();
  for (const w of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3) out.add(w);
  }
  return out;
}

/** True when a file path / component name shares a token with the feature keywords. */
function matchesKeywords(pathOrName: string, keywords: Set<string>): boolean {
  if (keywords.size === 0) return false;
  for (const t of fileNameTokens(pathOrName)) {
    if (keywords.has(t)) return true;
  }
  return false;
}

/**
 * Fetch the ACTUAL source of an existing MaxView page (resolved from a route) plus relevant
 * child component sources, following local imports breadth-first up to MAX_PAGE_CONTEXT_DEPTH.
 * Depth-1 imports are always included (page-shell fidelity); deeper imports are followed only
 * when their component name matches the feature keywords, so in-page sub-views (modals,
 * snapshots, drawers) that live several levels below the page are reached without pulling the
 * whole component tree. When provided, the route's inventory "Key components" that match the
 * keywords are also seeded. Returns a concatenated, delimited text block capped at
 * MAX_PAGE_CONTEXT_BYTES. Returns '' on any failure (non-fatal).
 */
export async function fetchExistingPageContext(route: string, featureText?: string): Promise<string> {
  if (!route?.trim()) return '';

  const keywords = featureText ? extractKeywords(featureText) : new Set<string>();
  const keywordSig = [...keywords].sort((a, b) => a.localeCompare(b)).join(',');
  const cacheKey = `${normaliseRoute(route)}::${keywordSig}`;
  const cached = pageContextCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PAGE_CONTEXT_TTL_MS) {
    return cached.context;
  }

  const orgUrl = process.env.ADO_ORG;
  const pat = process.env.ADO_PAT;
  if (!orgUrl || !pat) {
    console.warn('[designSystemService] fetchExistingPageContext: ADO_ORG or ADO_PAT not set');
    return '';
  }

  let pagePath: string | null = null;
  try {
    pagePath = await resolvePageFilePath(orgUrl, pat, route);
  } catch (e: any) {
    console.warn(`[designSystemService] fetchExistingPageContext: resolve failed for ${route} — ${e.message}`);
  }
  if (!pagePath) {
    console.warn(`[designSystemService] fetchExistingPageContext: could not resolve route ${route} to a component file`);
    return '';
  }

  const page = await fetchSourceWithExtensions(orgUrl, pat, pagePath);
  if (!page) {
    console.warn(`[designSystemService] fetchExistingPageContext: could not fetch source at ${pagePath}`);
    return '';
  }

  const sections: string[] = [];
  let budget = MAX_PAGE_CONTEXT_BYTES;

  const addSection = (path: string, src: string): void => {
    if (budget <= 0) return;
    let body = src;
    const overhead = path.length + 32;
    if (body.length + overhead > budget) {
      body = body.slice(0, Math.max(0, budget - overhead)) + '\n/* …truncated… */';
    }
    sections.push(`### File: ${path}\n\n\`\`\`tsx\n${body}\n\`\`\``);
    budget -= body.length + overhead;
  };

  // `enqueuedRefs` tracks import refs already chosen (pre-resolution); `emittedPaths` tracks
  // resolved file paths already added to the output, so a file reached via multiple refs is
  // emitted and expanded only once.
  const enqueuedRefs = new Set<string>();
  const emittedPaths = new Set<string>([page.path]);
  addSection(page.path, page.src);

  // Breadth-first frontier of fetched files whose imports we still need to expand.
  let frontier: Array<{ path: string; src: string; depth: number }> = [
    { path: page.path, src: page.src, depth: 0 },
  ];

  // Key-component seeding: pull inventory "Key components" that match the feature keywords
  // (resolved by name) as depth-1 seeds so feature-relevant sub-views are reached even when
  // they are not a clean relative-import chain from the page file.
  if (keywords.size > 0) {
    try {
      const inventory = await getScreenInventory();
      const row = inventory.find(s => routesEqual(s.route, route));
      const seedNames = (row?.keyComponents ?? []).filter(kc => matchesKeywords(kc, keywords));
      const seeds = await Promise.allSettled(
        seedNames.map(async name => {
          const located = await findComponentPath(orgUrl, pat, name);
          return located ? fetchSourceWithExtensions(orgUrl, pat, located) : null;
        }),
      );
      for (const result of seeds) {
        if (budget <= 0) break;
        if (result.status === 'fulfilled' && result.value && !emittedPaths.has(result.value.path)) {
          emittedPaths.add(result.value.path);
          addSection(result.value.path, result.value.src);
          frontier.push({ path: result.value.path, src: result.value.src, depth: 1 });
        }
      }
    } catch (e: any) {
      console.warn(`[designSystemService] fetchExistingPageContext: key-component seeding failed — ${e.message}`);
    }
  }

  while (frontier.length > 0 && budget > 0) {
    // Collect candidate imports from the current frontier: depth-1 imports always; deeper
    // imports only when their name matches the feature keywords. A ref reached from several
    // parents keeps the shallowest depth.
    const candidateDepth = new Map<string, number>();
    for (const node of frontier) {
      if (node.depth >= MAX_PAGE_CONTEXT_DEPTH) continue;
      const childDepth = node.depth + 1;
      for (const ref of parseLocalImportRefs(node.src, node.path)) {
        if (enqueuedRefs.has(ref)) continue;
        if (childDepth >= 2 && !matchesKeywords(ref, keywords)) continue;
        const prev = candidateDepth.get(ref);
        if (prev === undefined || childDepth < prev) candidateDepth.set(ref, childDepth);
      }
    }
    if (candidateDepth.size === 0) break;

    // Mark every candidate ref enqueued up-front so a failed/aliased fetch is not retried.
    const entries = [...candidateDepth.entries()];
    for (const [ref] of entries) enqueuedRefs.add(ref);

    const fetched = await Promise.allSettled(
      entries.map(async ([ref, depth]) => {
        const r = await fetchSourceWithExtensions(orgUrl, pat, ref);
        return r ? { path: r.path, src: r.src, depth } : null;
      }),
    );

    const nextFrontier: Array<{ path: string; src: string; depth: number }> = [];
    for (const result of fetched) {
      if (budget <= 0) break;
      if (result.status === 'fulfilled' && result.value) {
        const { path, src, depth } = result.value;
        if (emittedPaths.has(path)) continue;
        emittedPaths.add(path);
        addSection(path, src);
        nextFrontier.push({ path, src, depth });
      } else if (result.status === 'rejected') {
        console.warn(`[designSystemService] fetchExistingPageContext: child fetch failed — ${result.reason}`);
      }
    }

    frontier = nextFrontier;
  }

  const context = sections.join('\n\n');
  pageContextCache.set(cacheKey, { context, fetchedAt: Date.now() });
  console.log(
    `[designSystemService] fetchExistingPageContext: route ${route} → ${pagePath} ` +
    `(${sections.length} file(s), ${context.length} chars, ${keywords.size} keyword(s))`
  );
  return context;
}

/* ── Screen inventory + route inference ───────────────────────── */

interface ScreenInventoryCacheEntry {
  rows: ParsedScreenRow[];
  fetchedAt: number;
}

let screenInventoryCache: ScreenInventoryCacheEntry | null = null;

/** Map an internal parsed row to the shared, public ScreenInventoryRoute shape. */
function toScreenInventoryRoute(r: ParsedScreenRow): ScreenInventoryRoute {
  return {
    route: r.route,
    file: r.file,
    purpose: r.purpose,
    ...(r.userTypes?.length ? { userTypes: r.userTypes } : {}),
    ...(r.states ? { states: r.states } : {}),
    ...(r.keyComponents?.length ? { keyComponents: r.keyComponents } : {}),
  };
}

/**
 * Fetch and parse the clientapp-screens.md inventory (Route → Component/File → Purpose).
 * Returns [] when ADO creds are missing or the inventory cannot be fetched (non-fatal).
 * Cached for CATALOG_TTL_MS.
 */
export async function getScreenInventory(): Promise<ScreenInventoryRoute[]> {
  const now = Date.now();
  if (screenInventoryCache && now - screenInventoryCache.fetchedAt < CATALOG_TTL_MS) {
    return screenInventoryCache.rows.map(toScreenInventoryRoute);
  }

  const orgUrl = process.env.ADO_ORG;
  const pat = process.env.ADO_PAT;
  if (!orgUrl || !pat) {
    console.warn('[designSystemService] getScreenInventory: ADO_ORG or ADO_PAT not set — returning empty inventory');
    return [];
  }

  try {
    const md = await fetchAdoFile(orgUrl, pat, SCREENS_INVENTORY_PATH);
    const rows = parseScreenInventory(md);
    screenInventoryCache = { rows, fetchedAt: now };
    console.log(`[designSystemService] getScreenInventory: ${rows.length} screen(s) loaded`);
    return rows.map(toScreenInventoryRoute);
  } catch (e: any) {
    console.warn(`[designSystemService] getScreenInventory: failed — ${e.message}`);
    return [];
  }
}

/* ── Route inference (match backlog features to existing pages) ── */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'page', 'view', 'screen',
  'user', 'users', 'when', 'then', 'should', 'shall', 'will', 'able', 'want', 'wants',
  'allow', 'allows', 'show', 'shows', 'display', 'displays', 'list', 'lists', 'manage',
  'management', 'add', 'adds', 'create', 'update', 'edit', 'view', 'feature', 'features',
  'data', 'information', 'their', 'they', 'have', 'has', 'can', 'new', 'all', 'each',
  'within', 'where', 'which', 'including', 'include', 'such', 'these', 'those',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Identity keywords for a screen: route path segments + component name (camelCase split). */
function routeIdentityKeywords(route: string, file: string): Set<string> {
  const words = new Set<string>();
  for (const seg of route.replace(/[?#].*$/, '').split(/[/\-_]/)) {
    const w = seg.toLowerCase();
    if (w.length >= 3 && !STOPWORDS.has(w)) words.add(w);
  }
  const compMatch = file.match(/([A-Za-z][A-Za-z0-9]+)/);
  if (compMatch) {
    const camelWords = compMatch[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
    for (const w of camelWords) {
      if (w.length >= 3 && !STOPWORDS.has(w)) words.add(w);
    }
  }
  return words;
}

function purposeKeywords(purpose: string): Set<string> {
  const words = new Set<string>();
  for (const w of tokenize(purpose)) {
    if (w.length >= 4 && !STOPWORDS.has(w)) words.add(w);
  }
  return words;
}

/**
 * Infer the best-matching existing-page route for a chunk of feature text.
 * Conservative: requires at least one identity (route/component) keyword to match
 * and a clear winning margin, so brand-new screens get no route.
 * Returns the inventory route string, or null when no confident match exists.
 */
function inferRouteForText(text: string, inventory: ScreenInventoryRoute[]): string | null {
  const featureTokens = new Set(tokenize(text).filter(w => w.length >= 3));
  if (featureTokens.size === 0) return null;

  type Scored = { route: string; identityHits: number; total: number };
  const scored: Scored[] = [];

  for (const screen of inventory) {
    const identity = routeIdentityKeywords(screen.route, screen.file ?? '');
    const purpose = purposeKeywords(screen.purpose ?? '');

    let identityHits = 0;
    for (const kw of identity) if (featureTokens.has(kw)) identityHits += 1;
    let purposeHits = 0;
    for (const kw of purpose) if (featureTokens.has(kw)) purposeHits += 1;

    const total = identityHits * 2 + purposeHits;
    if (identityHits > 0) scored.push({ route: screen.route, identityHits, total });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.total - a.total || b.identityHits - a.identityHits);

  const best = scored[0];
  const second = scored[1];
  // Require a clear winner: either the only identity match, or a margin of >= 2 over the runner-up.
  if (second && best.total - second.total < 2 && best.identityHits <= second.identityHits) {
    return null;
  }
  return best.route;
}

interface InferableFeature {
  title?: string;
  description?: string;
  route?: string;
  items?: Array<{ title?: string; description?: string }>;
  pbis?: Array<{ title?: string; description?: string }>;
}

function buildFeatureText(feature: InferableFeature): string {
  const parts: string[] = [];
  if (feature.title) parts.push(feature.title);
  if (feature.description) parts.push(feature.description);
  for (const item of [...(feature.items ?? []), ...(feature.pbis ?? [])]) {
    if (item.title) parts.push(item.title);
    if (item.description) parts.push(item.description);
  }
  return parts.join(' ');
}

/**
 * Walk a backlog JSON tree and set `route` on each feature that clearly extends an
 * existing MaxView page (matched against the screen inventory). Features that already
 * carry a non-empty `route` are left untouched, and brand-new screens get no route.
 * Mutates and returns the same object. Non-fatal: returns the input unchanged when the
 * inventory is unavailable.
 */
export async function inferRoutesForBacklog(
  backlogJson: unknown,
): Promise<{ backlog: unknown; inferredCount: number }> {
  if (!backlogJson || typeof backlogJson !== 'object') {
    return { backlog: backlogJson, inferredCount: 0 };
  }

  let inventory: ScreenInventoryRoute[] = [];
  try {
    inventory = await getScreenInventory();
  } catch {
    inventory = [];
  }
  if (inventory.length === 0) return { backlog: backlogJson, inferredCount: 0 };

  const bj = backlogJson as {
    features?: InferableFeature[];
    epics?: Array<{ features?: InferableFeature[] }>;
  };

  const features: InferableFeature[] = [];
  if (Array.isArray(bj.features)) features.push(...bj.features);
  if (Array.isArray(bj.epics)) {
    for (const epic of bj.epics) {
      if (Array.isArray(epic?.features)) features.push(...epic.features);
    }
  }

  let inferredCount = 0;
  for (const feature of features) {
    if (typeof feature?.route === 'string' && feature.route.trim()) continue;
    const match = inferRouteForText(buildFeatureText(feature), inventory);
    if (match) {
      feature.route = match;
      inferredCount += 1;
    }
  }

  if (inferredCount > 0) {
    console.log(`[designSystemService] inferRoutesForBacklog: inferred route for ${inferredCount} feature(s)`);
  }
  return { backlog: backlogJson, inferredCount };
}

/** Force-clear the catalog cache (useful in tests). */
export function clearDesignSystemCache(): void {
  catalogCache = null;
  pageContextCache.clear();
  screenInventoryCache = null;
}
