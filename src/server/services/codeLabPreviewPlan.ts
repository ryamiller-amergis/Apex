import { CODE_LAB_PREVIEW_ROUTE, type CodeLabPreviewInfo } from '../../shared/types/codeLab';

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

/** Path segment under the preview base that carries the app's own server calls. */
export const CODE_LAB_PREVIEW_BACKEND_SEGMENT = '__backend__';

/**
 * The opaque origin cannot call the host's API directly (CORS). Same-origin
 * fetch/XHR calls outside the base are rerouted under `<base>__backend__`
 * without credentials; the preview route forwards them as an anonymous visitor.
 * Expects `b` (the base path) in scope.
 */
const BACKEND_REROUTE_SCRIPT = [
  `var k=b+'${CODE_LAB_PREVIEW_BACKEND_SEGMENT}';`,
  'function r(u){try{var x=new URL(u,location.href);',
  'if(x.origin===location.origin&&x.pathname.indexOf(b)!==0)return k+x.pathname+x.search+x.hash}catch(e){}return null}',
  'var F=window.fetch;window.fetch=function(i,o){',
  "var s=typeof i==='string'||i instanceof URL;var t=r(s?String(i):i&&i.url);",
  'if(!t)return F.apply(this,arguments);',
  "return F.call(this,s?t:new Request(t,i),Object.assign({},o,{credentials:'omit'}))};",
  'var X=XMLHttpRequest.prototype,O=X.open,S=X.send;',
  'X.open=function(m,u){var t=r(String(u));this.__codeLab=!!t;if(t)arguments[1]=t;return O.apply(this,arguments)};',
  'X.send=function(){if(this.__codeLab)this.withCredentials=false;return S.apply(this,arguments)};',
].join('');

/**
 * Returns the host path (with query) a rerouted preview call targets, or null
 * when the URL is not a backend call or points back into a Code Lab preview.
 */
export function resolvePreviewBackendPath(originalUrl: string, basePath: string): string | null {
  const prefix = basePath + CODE_LAB_PREVIEW_BACKEND_SEGMENT;
  if (!originalUrl.startsWith(prefix)) return null;
  const rest = originalUrl.slice(prefix.length);
  if (!rest.startsWith('/')) return null;
  const url = new URL(`http://placeholder${rest}`);
  const pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (pathname.toLowerCase().startsWith(`/api${CODE_LAB_PREVIEW_ROUTE}`)) return null;
  return pathname + url.search;
}

/**
 * Runs before the app boots. Client-side routers read `location.pathname`, so
 * the address moves from `<base>settings` to `/settings` and routes match.
 * Assets keep loading because Vite writes them as absolute URLs under the base.
 */
export function injectPreviewBootstrap(html: string, basePath: string): string {
  const script = `<script>(function(){${STORAGE_FALLBACK_SCRIPT}var b=${JSON.stringify(basePath)};${BACKEND_REROUTE_SCRIPT}var p=location.pathname;`
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
