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
  const files = ctx.files.filter((f) => /\.(css|scss|less)$/i.test(f));
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
        if (VENDOR_PREFIXES.some((p) => key.startsWith(p))) continue;
        out.push(entry('css-variables', key, m[2].trim(), rel, i + 1));
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
  const pkgRel = ctx.files.find((f) => f === 'package.json');
  if (!pkgRel) return out;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ctx.repoRoot, pkgRel), 'utf8'));
  } catch {
    return out;
  }
  if (pkg.name) out.push(entry('stack', 'projectName', pkg.name, pkgRel));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const known = ['react', 'vue', 'svelte', 'express', 'next', 'vite', '@mui/material', 'tailwindcss'];
  for (const dep of known) {
    if (deps[dep]) out.push(entry('stack', `dep:${dep}`, deps[dep], pkgRel));
  }
  return out;
}

/**
 * Terminology/glossary extractor: markdown table rows "| Term | Meaning |"
 * from any glossary/context doc. Pure structural parse, no inference.
 */
export function detectGlossary(ctx) {
  const out = [];
  const files = ctx.files.filter((f) => /\.md$/i.test(f) && /(context|glossary|agents)/i.test(f));
  const rowRe = /^\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/;
  for (const rel of files) {
    const lines = readLines(path.join(ctx.repoRoot, rel));
    if (!lines) continue;
    for (let i = 0; i < lines.length; i++) {
      const m = rowRe.exec(lines[i]);
      if (!m) continue;
      const term = m[1].trim();
      const meaning = m[2].trim();
      if (/^-+$/.test(term) || /term/i.test(term) === false && meaning.length < 3) continue;
      if (/^-+$/.test(meaning)) continue;
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
  const all = ctx.files.map((f) => f.toLowerCase());

  // Primary context / product guide file
  const contextCandidates = ['context.md', 'contexts.md', 'agents.md', 'readme.md'];
  for (const candidate of ['CONTEXT.md', 'context.md', 'docs/context.md']) {
    if (ctx.files.includes(candidate)) {
      out.push(entry('repo-docs', 'contextFile', candidate, candidate));
      break;
    }
  }
  if (!out.find((e) => e.key === 'contextFile')) {
    // Fallback: uppercase README or context variant
    const fallback = ctx.files.find((f) => /^(context|readme)\.md$/i.test(f));
    if (fallback) out.push(entry('repo-docs', 'contextFile', fallback, fallback));
  }

  // AGENTS.md
  const agentsFile = ctx.files.find((f) => /^agents\.md$/i.test(f));
  if (agentsFile) out.push(entry('repo-docs', 'agentsFile', agentsFile, agentsFile));

  // Changelog
  const changelogCandidates = ['public/CHANGELOG.json', 'CHANGELOG.md', 'CHANGELOG.json', 'changelog.md'];
  for (const c of changelogCandidates) {
    if (ctx.files.includes(c) || ctx.files.map((f) => f.toLowerCase()).includes(c.toLowerCase())) {
      const actual = ctx.files.find((f) => f.toLowerCase() === c.toLowerCase()) ?? c;
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
