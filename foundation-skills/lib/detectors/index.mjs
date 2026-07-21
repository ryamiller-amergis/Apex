/**
 * Shared detector library
 *
 * Each detector reads specific signals from a target repo and emits structured
 * evidence objects. Every evidence entry carries a `file` (and optional `line`)
 * so downstream slot-templating can trace every fact.
 *
 * Exported functions:
 *   detectCssVariables(repoRoot)   — CSS custom properties / design tokens
 *   detectComponents(repoRoot)     — component index (dirs, named exports)
 *   detectRoutes(repoRoot)         — route / module map
 *   detectStack(repoRoot)          — package.json / tech stack
 *   detectTerminology(repoRoot)    — glossary / domain terms
 *   detectConventions(repoRoot)    — directory/naming conventions
 */

export { detectCssVariables }  from './css-variables.mjs';
export { detectComponents }    from './component-index.mjs';
export { detectRoutes }        from './route-module-map.mjs';
export { detectStack }         from './package-stack.mjs';
export { detectTerminology }   from './terminology-glossary.mjs';
export { detectConventions }   from './directory-conventions.mjs';

/**
 * Run all detectors and return a combined evidence object.
 * Used by the bootstrapper as the full-repo scan.
 *
 * @param {string}   repoRoot
 * @param {object}   [opts]
 * @param {string[]} [opts.scope]   list of detector names to include (default: all)
 * @param {number}   [opts.capMs]   hard time ceiling per detector in ms (default 45000)
 * @param {Function} [opts.onProgress] called with { detector, status } updates
 */
export async function runDetectors(repoRoot, { scope, capMs = 45_000, onProgress } = {}) {
  const { detectCssVariables }  = await import('./css-variables.mjs');
  const { detectComponents }    = await import('./component-index.mjs');
  const { detectRoutes }        = await import('./route-module-map.mjs');
  const { detectStack }         = await import('./package-stack.mjs');
  const { detectTerminology }   = await import('./terminology-glossary.mjs');
  const { detectConventions }   = await import('./directory-conventions.mjs');

  const all = {
    cssVariables:  detectCssVariables,
    components:    detectComponents,
    routes:        detectRoutes,
    stack:         detectStack,
    terminology:   detectTerminology,
    conventions:   detectConventions,
  };

  const toRun = scope ? Object.fromEntries(Object.entries(all).filter(([k]) => scope.includes(k))) : all;
  const results = {};

  for (const [name, fn] of Object.entries(toRun)) {
    onProgress?.({ detector: name, status: 'start' });
    try {
      results[name] = await Promise.race([
        fn(repoRoot),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`cap:${capMs}ms exceeded`)), capMs)
        ),
      ]);
      onProgress?.({ detector: name, status: 'done', count: results[name]?.length ?? 0 });
    } catch (err) {
      results[name] = [];
      onProgress?.({ detector: name, status: 'capped', reason: err.message });
    }
  }

  return results;
}
