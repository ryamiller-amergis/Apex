import type { CodeLabPreviewInfo } from '../../shared/types/codeLab';

/** Folders checked for a web app, in priority order. */
export const CODE_LAB_APP_DIR_CANDIDATES = [
  '.',
  'client',
  'frontend',
  'web',
  'app',
  'ui',
  'apps/web',
  'packages/web',
] as const;

export interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface PreviewCandidate {
  appDir: string;
  packageJson: PackageJsonLike | null;
  hasIndexHtml: boolean;
}

interface UnsupportedStack {
  dependency: string;
  label: string;
}

/**
 * Stacks the preview cannot serve yet: each needs its base path set in its own
 * config file, which Code Lab does not rewrite. Checked before `vite` because
 * several of them run on Vite internally.
 */
const UNSUPPORTED_STACKS: readonly UnsupportedStack[] = [
  { dependency: 'next', label: 'Next.js' },
  { dependency: 'nuxt', label: 'Nuxt' },
  { dependency: '@sveltejs/kit', label: 'SvelteKit' },
  { dependency: '@remix-run/dev', label: 'Remix' },
  { dependency: 'astro', label: 'Astro' },
  { dependency: '@angular/core', label: 'Angular' },
  { dependency: 'react-scripts', label: 'Create React App' },
];

const VITE_UI_LIBRARIES: readonly UnsupportedStack[] = [
  { dependency: 'react', label: 'React' },
  { dependency: 'vue', label: 'Vue' },
  { dependency: 'svelte', label: 'Svelte' },
  { dependency: 'solid-js', label: 'Solid' },
  { dependency: 'preact', label: 'Preact' },
  { dependency: 'lit', label: 'Lit' },
];

function allDependencies(pkg: PackageJsonLike): Record<string, string> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

function classify(candidate: PreviewCandidate): CodeLabPreviewInfo | null {
  const { appDir, packageJson, hasIndexHtml } = candidate;

  if (!packageJson) {
    return hasIndexHtml ? { kind: 'static', label: 'Static HTML', appDir } : null;
  }

  const deps = allDependencies(packageJson);
  const unsupported = UNSUPPORTED_STACKS.find((stack) => stack.dependency in deps);
  if (unsupported) {
    return {
      kind: 'unsupported',
      label: unsupported.label,
      appDir,
      reason: `${unsupported.label} apps are not supported by the Code Lab preview yet. Code changes and diffs still work.`,
    };
  }

  if ('vite' in deps) {
    const library = VITE_UI_LIBRARIES.find((lib) => lib.dependency in deps);
    return { kind: 'vite', label: library ? `${library.label} + Vite` : 'Vite', appDir };
  }

  return hasIndexHtml ? { kind: 'static', label: 'Static HTML', appDir } : null;
}

/**
 * The sandboxed preview has an opaque origin, where reading `localStorage`,
 * `sessionStorage`, or `document.cookie` throws and crashes most apps on boot.
 * Swap in per-page in-memory stand-ins only when the real ones throw.
 */
const STORAGE_FALLBACK_SCRIPT = [
  'function m(){var d={};return{get length(){return Object.keys(d).length},',
  'key:function(i){var k=Object.keys(d)[i];return k===undefined?null:k},',
  'getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},',
  'setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},',
  'clear:function(){d={}}}}',
  "['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('')}catch(e){",
  'Object.defineProperty(window,n,{value:m(),configurable:true})}});',
  'try{document.cookie}catch(e){',
  "Object.defineProperty(document,'cookie',{get:function(){return''},set:function(){},configurable:true})}",
].join('');

/**
 * Runs before the app boots. Client-side routers read `location.pathname`, so
 * the address moves from `<base>settings` to `/settings` and routes match.
 * Assets keep loading because Vite writes them as absolute URLs under the base.
 */
export function injectPreviewBootstrap(html: string, basePath: string): string {
  const script = `<script>(function(){${STORAGE_FALLBACK_SCRIPT}var b=${JSON.stringify(basePath)};var p=location.pathname;`
    + `if(p.indexOf(b)===0){history.replaceState(history.state,'','/'+p.slice(b.length)+location.search+location.hash);}})();</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return script + html;
  const insertAt = head.index + head[0].length;
  return html.slice(0, insertAt) + script + html.slice(insertAt);
}

/**
 * Picks how to preview a repository. The first runnable candidate wins; when
 * none is runnable, the first recognized-but-unsupported stack explains why.
 */
export function resolvePreviewPlan(candidates: readonly PreviewCandidate[]): CodeLabPreviewInfo {
  let firstUnsupported: CodeLabPreviewInfo | null = null;
  for (const candidate of candidates) {
    const plan = classify(candidate);
    if (!plan) continue;
    if (plan.kind !== 'unsupported') return plan;
    firstUnsupported ??= plan;
  }
  return firstUnsupported ?? {
    kind: 'unsupported',
    label: 'Unknown',
    appDir: '.',
    reason: 'No web app was found. Code Lab previews Vite apps and static HTML sites. Code changes and diffs still work.',
  };
}
