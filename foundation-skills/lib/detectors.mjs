/**
 * Shared detector library. Each detector is deterministic, reads only files
 * provided by the bounded scan context, and returns evidence entries of shape:
 *
 *   { key, value, source: { file, line? }, detector }
 *
 * Detectors never invent values; every entry is backed by a real file location.
 * Recipes compose these detectors via a declarative slot-map (see template.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './util.mjs';

function readLines(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

function entry(detector, key, value, file, line) {
  return { detector, key, value, source: line ? { file, line } : { file } };
}

/** CSS custom-property extractor: `--token: value;` across stylesheet files. */
export function detectCssVariables(ctx) {
  const out = [];
  const files = ctx.files
    .filter((f) => /\.(css|scss|less)$/i.test(f))
    .filter((f) => isAllowedCssPath(f))
    .sort(compareCssPriority);
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  // Third-party tool prefixes that are never part of an app's own design system.
  const VENDOR_PREFIXES = ['--ifm-', '--docusaurus-', '--swm-', '--prism-'];
  for (const rel of files) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(lines[i])) !== null) {
        const key = m[1].trim();
        const value = m[2].trim();
        if (VENDOR_PREFIXES.some((p) => key.startsWith(p))) continue;
        if (isUnsafeCssValue(value)) continue;
        out.push(entry('css-variables', key, value, rel, i + 1));
      }
    }
  }
  return dedupeByKey(out);
}

/** Component index: names of component files under a components directory. */
export function detectComponents(ctx) {
  const out = [];
  const files = ctx.files.filter(
    (f) =>
      /(^|\/)components\//i.test(f) &&
      /\.(tsx|jsx)$/.test(f) &&
      !/(\.test\.|\.spec\.|\.stories\.)/i.test(f),
  );
  for (const rel of files) {
    const base = path.basename(rel).replace(/\.(tsx|jsx)$/, '');
    if (/^[A-Z]/.test(base)) out.push(entry('components', base, rel, rel));
  }
  return dedupeByKey(out);
}

/** Route/module map: string literals passed to route path props/definitions. */
export function detectRoutes(ctx) {
  const out = [];
  const files = ctx.files.filter((f) => /\.(tsx|jsx|ts)$/.test(f));
  const re = /path\s*[:=]\s*["'`](\/[^"'`]*)["'`]/g;
  for (const rel of files) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(lines[i])) !== null) {
        out.push(entry('routes', m[1], m[1], rel, i + 1));
      }
    }
  }
  return dedupeByKey(out);
}

/** Package/stack reader: name, framework signals, scripts from package.json. */
export function detectStack(ctx) {
  const out = [];
  const pkgFiles = ctx.files
    .filter((f) => /(^|\/)package\.json$/i.test(f))
    .sort(comparePackagePriority);

  const projectTitle = findProjectTitle(ctx);
  if (projectTitle) {
    out.push(entry('stack', 'projectName', projectTitle.value, projectTitle.file, projectTitle.line));
  }

  const known = ['react', 'react-dom', 'vue', 'svelte', 'express', 'next', 'vite', '@mui/material', 'tailwindcss'];
  for (const pkgRel of pkgFiles) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, pkgRel), 'utf8'));
    } catch {
      continue;
    }
    if (pkgRel === 'package.json' && pkg.name) {
      out.push(entry('stack', 'projectName', pkg.name, pkgRel));
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const dep of known) {
      if (deps[dep]) out.push(entry('stack', `dep:${dep}`, deps[dep], pkgRel));
    }
  }
  return dedupeByKey(out);
}

/**
 * Terminology/glossary extractor: markdown table rows "| Term | Meaning |"
 * from any glossary/context doc. Pure structural parse, no inference.
 */
export function detectGlossary(ctx) {
  const out = [];
  const files = ctx.files
    .filter((f) => /\.md$/i.test(f) && isGlossaryCandidate(f))
    .filter((f) => !isExcludedGlossaryPath(f))
    .sort(compareGlossaryPriority);
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/;
  for (const rel of files) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    let inSection = false;
    for (let i = 0; i < lines.length; i++) {
      if (TERMINOLOGY_HEADING_RE.test(lines[i])) {
        inSection = true;
        continue;
      }
      if (inSection && /^##\s+/.test(lines[i])) {
        inSection = false;
      }
      if (!inSection) continue;
      const m = rowRe.exec(lines[i]);
      if (!m) continue;
      const term = stripMarkdownDecorators(m[1].trim());
      const meaning = m[2].trim();
      if (isTableSeparator(term) || isTableSeparator(meaning)) continue;
      if (isGlossaryHeader(term, meaning)) continue;
      out.push(entry('glossary', term, meaning, rel, i + 1));
    }
  }
  return dedupeByKey(out);
}

/** Directory-convention detector: top-level source directories. */
export function detectDirConventions(ctx) {
  const out = [];
  const dirs = new Set();
  for (const f of ctx.files) {
    const top = f.split('/').slice(0, 2).join('/');
    if (top.startsWith('src/')) dirs.add(top);
  }
  for (const d of [...dirs].sort()) {
    out.push(entry('dir-conventions', d, d, toPosix(d) + '/'));
  }
  return out;
}

/**
 * Typography detector: extracts font-family, font-size, font-weight, and
 * line-height CSS custom properties. Gives bootstrap enough to write a
 * meaningful typography section without any manual TODO.
 */
export function detectTypography(ctx) {
  const out = [];
  const files = ctx.files.filter((f) => /\.(css|scss|less)$/i.test(f));
  const VENDOR_PREFIXES = ['--ifm-', '--docusaurus-', '--swm-', '--prism-'];
  const fontRe = /(--[a-z0-9-]*(?:font|type|text|heading|body|label|caption)[a-z0-9-]*)\s*:\s*([^;]+);/gi;
  for (const rel of files) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      let m;
      fontRe.lastIndex = 0;
      while ((m = fontRe.exec(lines[i])) !== null) {
        const key = m[1].trim();
        if (VENDOR_PREFIXES.some((p) => key.startsWith(p))) continue;
        out.push(entry('typography', key, m[2].trim(), rel, i + 1));
      }
    }
  }
  // Also scan theme/token TypeScript files for font-stack patterns.
  const tsFiles = ctx.files.filter((f) => /\.(ts|tsx)$/i.test(f) && /(theme|token|typography|font)/i.test(f));
  const tsFontFamilyRe = /fontFamily\s*[:=]\s*["'`]([^"'`]+)["'`]/g;
  const tsFontSizeRe = /fontSize\s*[:=]\s*([\d.]+(?:px|rem|em)?)/g;
  for (const rel of tsFiles) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      let m;
      tsFontFamilyRe.lastIndex = 0;
      while ((m = tsFontFamilyRe.exec(lines[i])) !== null) {
        out.push(entry('typography', 'fontFamily', m[1].trim(), rel, i + 1));
      }
      tsFontSizeRe.lastIndex = 0;
      while ((m = tsFontSizeRe.exec(lines[i])) !== null) {
        out.push(entry('typography', `fontSize:${m[1]}`, m[1].trim(), rel, i + 1));
      }
    }
  }
  return dedupeByKey(out);
}

/**
 * App-shell detector: scans navigation/shell/layout component files to extract
 * menu labels, persistent chrome description, and structural landmarks.
 * Produces entries that bootstrap uses to write the App Shell section.
 */
export function detectAppShell(ctx) {
  const out = [];
  // Target shell/nav/layout component files and navigation config files — exclude tests and stories.
  const shellFiles = ctx.files.filter((f) =>
    /\.(tsx|jsx|ts|js)$/i.test(f) &&
    !/(\.test\.|\.spec\.|\.stories\.)/i.test(f) &&
    (
      /(AppShell|AppBar|Sidebar|SideNav|NavBar|TopNav|TopBar|Header|Layout|Navigation|MainNav|SiteNav)/i.test(
        path.basename(f),
      ) ||
      // Navigation config files (e.g. build-navigation.ts, nav-config.ts, routes.ts)
      /(build[-_]?nav|nav[-_]?config|nav[-_]?items|menu[-_]?items|sidebar[-_]?items|navigation[-_]?config)/i.test(
        path.basename(f),
      )
    ),
  );

  // Patterns that indicate a nav menu item label.
  const labelRe = /(?:label|title|text|name|heading)\s*[:=]\s*["'`]([A-Z][A-Za-z0-9 /-]{2,40})["'`]/g;
  // Route/to/href strings that look like navigation paths.
  const routeRe = /(?:to|href|path)\s*[:=]\s*["'`](\/[A-Za-z0-9/-]{1,60})["'`]/g;

  const labels = new Set();
  const routes = new Set();

  for (const rel of shellFiles) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      let m;
      labelRe.lastIndex = 0;
      while ((m = labelRe.exec(lines[i])) !== null) {
        const label = m[1].trim();
        if (!labels.has(label)) {
          labels.add(label);
          out.push(entry('app-shell', `nav:${label}`, label, rel, i + 1));
        }
      }
      routeRe.lastIndex = 0;
      while ((m = routeRe.exec(lines[i])) !== null) {
        const route = m[1].trim();
        if (!routes.has(route)) {
          routes.add(route);
          out.push(entry('app-shell', `route:${route}`, route, rel, i + 1));
        }
      }
    }
  }

  // Record which shell files were found (used for the file-list slot).
  for (const rel of shellFiles) {
    out.push(entry('app-shell', `file:${path.basename(rel)}`, rel, rel));
  }

  return out;
}

/**
 * Repo-docs detector: locates the project's primary context/knowledge file,
 * AGENTS.md equivalent, changelog, and key workflow directories.
 * These paths vary by repo but follow predictable naming conventions.
 */
export function detectRepoDocs(ctx) {
  const out = [];

  // Primary context / product guide file
  const contextFile = findFirstPath(
    ctx.files,
    [
      'CONTEXT.md',
      'context.md',
      'CONTEXT-MAP.md',
      'context-map.md',
      'README.md',
      'readme.md',
      'docs/CONTEXT.md',
      'docs/context.md',
      'docs/CONTEXT-MAP.md',
      'docs/context-map.md',
    ],
    /(^|\/)(context(?:-map)?|readme)\.md$/i,
  );
  if (contextFile) out.push(entry('repo-docs', 'contextFile', contextFile, contextFile));

  // AGENTS.md
  const agentsFile = findFirstPath(ctx.files, ['AGENTS.md', 'agents.md'], /(^|\/)agents\.md$/i);
  if (agentsFile) out.push(entry('repo-docs', 'agentsFile', agentsFile, agentsFile));

  const mission = findMissionEvidence(ctx);
  if (mission) out.push(entry('repo-docs', 'mission', mission.value, mission.file, mission.line));

  // Changelog
  const changelogCandidates = ['public/CHANGELOG.json', 'CHANGELOG.md', 'CHANGELOG.json', 'changelog.md'];
  for (const c of changelogCandidates) {
    const actual = ctx.files.find((f) => f.toLowerCase() === c.toLowerCase());
    if (actual) {
      out.push(entry('repo-docs', 'changelogFile', actual, actual));
      break;
    }
  }

  // AI-pilot workflow directory presence
  const hasAiPilot = ctx.files.some((f) => f.startsWith('.ai-pilot/'));
  out.push(entry('repo-docs', 'aiPilotDir', hasAiPilot ? '.ai-pilot/' : '.ai-pilot/', '.ai-pilot/'));

  // Design-docs directory
  const designDocsCandidates = ['design-docs/', 'docs/design/', 'docs/'];
  for (const d of designDocsCandidates) {
    if (ctx.files.some((f) => f.startsWith(d))) {
      out.push(entry('repo-docs', 'designDocsDir', d, d));
      break;
    }
  }

  // Skills / cursor directory
  const skillsDir = ctx.files.some((f) => f.startsWith('.cursor/skills/')) ? '.cursor/skills/' : '.cursor/skills/';
  out.push(entry('repo-docs', 'skillsDir', skillsDir, skillsDir));

  return out;
}

function dedupeByKey(entries) {
  const seen = new Map();
  for (const e of entries) {
    if (!seen.has(e.key)) seen.set(e.key, e);
  }
  return [...seen.values()];
}

const TERMINOLOGY_HEADING_RE = /^##\s+(Glossary|Terms|Key Terms|Terminology|Key Terminology)\b/i;
const CSS_EXCLUDED_SEGMENTS = new Set(['vendor', 'wwwroot', 'docs', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt']);
const GLOSSARY_EXCLUDED_SEGMENTS = new Set(['local-debug', 'infrastructure', 'infra']);

function comparePackagePriority(a, b) {
  return packagePriority(a) - packagePriority(b) || a.localeCompare(b);
}

function packagePriority(rel) {
  return rel === 'package.json' ? 0 : rel.split('/').length;
}

function compareGlossaryPriority(a, b) {
  return docPriority(a) - docPriority(b) || a.localeCompare(b);
}

function compareCssPriority(a, b) {
  return cssPriority(a) - cssPriority(b) || a.localeCompare(b);
}

function cssPriority(rel) {
  const lower = rel.toLowerCase();
  if (/(^|\/)(theme|tokens?|variables?|globals?)(\/|[-_.])/.test(lower) || /(theme|tokens?|variables?|globals?)/.test(path.basename(lower))) {
    return 0;
  }
  if (/\.module\.(css|scss|less)$/.test(lower)) return 1;
  return 2;
}

function isAllowedCssPath(rel) {
  const segments = rel.toLowerCase().split('/');
  return !segments.some((segment) => CSS_EXCLUDED_SEGMENTS.has(segment));
}

function isUnsafeCssValue(value) {
  return !value
    || value.length > 180
    || /[{}]/.test(value)
    || /\n/.test(value)
    || /\/\*/.test(value);
}

function isGlossaryCandidate(rel) {
  return /^(AGENTS|agents|CONTEXT|context|CONTEXT-MAP|context-map|README|readme|GLOSSARY|glossary)\.md$/i.test(rel)
    || /^docs\/GLOSSARY\.md$/i.test(rel);
}

function isExcludedGlossaryPath(rel) {
  const segments = rel.toLowerCase().split('/');
  return segments.some((segment) => GLOSSARY_EXCLUDED_SEGMENTS.has(segment));
}

function isTableSeparator(value) {
  return /^:?-{3,}:?$/.test(value);
}

function isGlossaryHeader(term, meaning) {
  return /^(term|key|name|abbreviation|acronym)$/i.test(term)
    && /^(meaning|definition|value|description|purpose)$/i.test(meaning);
}

function stripMarkdownDecorators(value) {
  return value.replace(/^\*\*|\*\*$/g, '').trim();
}

function findProjectTitle(ctx) {
  for (const rel of primaryContextCandidates()) {
    if (!ctx.files.includes(rel)) continue;
    const title = extractRootH1(path.join(ctx.repoRoot, rel));
    if (!title) continue;
    const normalized = normalizeProjectTitle(title.text, rel);
    if (!normalized) continue;
    return { value: normalized, file: rel, line: title.line };
  }
  for (const rel of ['AGENTS.md', 'agents.md']) {
    if (!ctx.files.includes(rel)) continue;
    const title = extractRootH1(path.join(ctx.repoRoot, rel));
    if (!title) continue;
    const normalized = normalizeProjectTitle(title.text, rel);
    if (!normalized) continue;
    return { value: normalized, file: rel, line: title.line };
  }
  return null;
}

function extractRootH1(absPath) {
  const lines = readLines(absPath);
  if (!lines) return null;
  for (let i = 0; i < lines.length; i++) {
    const match = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (match) {
      return { text: match[1].trim(), line: i + 1 };
    }
  }
  return null;
}

function normalizeProjectTitle(title, rel = '') {
  const metadataDerived = extractMetadataStyleProductTitle(title, rel);
  if (metadataDerived !== null) {
    title = metadataDerived;
  }

  const cleaned = title
    .replace(/\s+[\/|]\s+.+$/, '')
    .replace(/\s+[—–-]\s+.+$/, '')
    .replace(/\s+(Monorepo|Repository|Repo|Context Map)$/i, '')
    .trim();
  if (!cleaned) return null;
  if (/^(agents\.md|context\.md|context-map\.md|readme\.md)$/i.test(cleaned)) return null;
  if (/^(context|overview|introduction)$/i.test(cleaned)) return null;
  return cleaned;
}

function findFirstPath(files, preferred, fallbackRe) {
  for (const candidate of preferred) {
    if (files.includes(candidate)) return candidate;
  }
  return files
    .filter((file) => fallbackRe.test(file))
    .sort((a, b) => docPriority(a) - docPriority(b) || a.localeCompare(b))[0] ?? null;
}

function docPriority(rel) {
  if (!rel.includes('/')) {
    if (/^agents\.md$/i.test(rel)) return 0;
    if (/^context\.md$/i.test(rel)) return 1;
    if (/^context-map\.md$/i.test(rel)) return 2;
    if (/^readme\.md$/i.test(rel)) return 3;
    return 4;
  }
  return 10 + rel.split('/').length;
}

function findMissionEvidence(ctx) {
  const primaryContext = findPrimaryContextPath(ctx.files);
  if (!primaryContext) return null;
  const summary = extractTrustedProductSection(path.join(ctx.repoRoot, primaryContext));
  if (summary) return { value: summary.text, file: primaryContext, line: summary.line };
  return null;
}

function extractTrustedProductSection(absPath) {
  const lines = readLines(absPath);
  if (!lines) return null;
  let inTrustedSection = false;
  const paragraph = [];
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (TRUSTED_PRODUCT_SECTION_RE.test(line)) {
      inTrustedSection = true;
      paragraph.length = 0;
      startLine = 0;
      continue;
    }
    if (!inTrustedSection) continue;
    if (/^##\s+/.test(line)) break;
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (/^[-*]\s+/.test(line) || /^\|/.test(line) || /^>/.test(line)) break;
    if (paragraph.length === 0) startLine = i + 1;
    paragraph.push(line);
  }
  const text = normalizeMissionText(paragraph.join(' '));
  return text ? { text, line: startLine } : null;
}

function normalizeMissionText(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length < 24 || normalized.length > 220) return null;
  return normalized;
}

function primaryContextCandidates() {
  return ['CONTEXT.md', 'context.md', 'CONTEXT-MAP.md', 'context-map.md', 'README.md', 'readme.md'];
}

function findPrimaryContextPath(files) {
  return findFirstPath(
    files,
    [
      ...primaryContextCandidates(),
      'docs/CONTEXT.md',
      'docs/context.md',
      'docs/CONTEXT-MAP.md',
      'docs/context-map.md',
    ],
    /(^|\/)(context(?:-map)?|readme)\.md$/i,
  );
}

function extractMetadataStyleProductTitle(title, rel) {
  if (!/^agents\.md$/i.test(path.basename(rel || ''))) return null;
  if (!/^agents\.md\b/i.test(title)) return null;
  const extracted = /^agents\.md\s*[—–-]\s*([A-Za-z][A-Za-z0-9]+)\b/i.exec(title);
  return extracted ? extracted[1] : '';
}

const TRUSTED_PRODUCT_SECTION_RE = /^##\s+(What is .+\?|Application Summary|Product Overview|Purpose)\s*$/i;

export const DETECTORS = {
  'css-variables': detectCssVariables,
  components: detectComponents,
  routes: detectRoutes,
  stack: detectStack,
  glossary: detectGlossary,
  'dir-conventions': detectDirConventions,
  'repo-docs': detectRepoDocs,
  typography: detectTypography,
  'app-shell': detectAppShell,
};

export function runDetector(name, ctx) {
  const fn = DETECTORS[name];
  if (!fn) throw new Error(`Unknown detector: ${name}`);
  return fn(ctx);
}
