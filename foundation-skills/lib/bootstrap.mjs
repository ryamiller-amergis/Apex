/**
 * Bootstrap orchestration: Stage A (evidence) -> Stage B (slot templating) ->
 * optional Stage C (AI enrichment, opt-in, default OFF).
 *
 * Produces the adapter file set for one skill from the package's adapter
 * templates + recipe. Deterministic unless enrichment is explicitly enabled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, listFilesRel, normalizeText } from './util.mjs';
import { pkgAdapterDir } from './layout.mjs';
import { RECIPE_NAME } from './layout.mjs';
import { collectEvidence, indexEvidence } from './evidence.mjs';
import { renderTemplate, hasTodos } from './template.mjs';
import { skillRootWithTrailingSlash } from './skillRoot.mjs';

export function loadRecipe(pkgRoot, skill) {
  const p = path.join(pkgAdapterDir(pkgRoot, skill), RECIPE_NAME);
  if (!fs.existsSync(p)) return { skill, scanScope: 'targeted', detectors: [], slots: {} };
  return readJson(p);
}

/**
 * Bootstrap one skill's adapter files.
 * @param {object} [opts]
 * @param {boolean} [opts.enrich] enable Stage C (default false)
 * @param {(text:string, ctx:object)=>string} [opts.enricher] enrichment fn
 * @param {() => number} [opts.now] injectable clock for tests
 * @returns {{ files: Record<string,string>, explain: object, meta: object }}
 */
export function bootstrapSkill(pkgRoot, repoRoot, skill, opts = {}) {
  const { enrich = false, enricher = null, now } = opts;
  const recipe = loadRecipe(pkgRoot, skill);
  const { entries, meta } = collectEvidence(repoRoot, recipe, now ? { now } : {});
  const idx = indexEvidence(entries);
  if (opts.skillRoot) {
    (idx['repo-docs'] ??= {}).skillsDir = {
      detector: 'repo-docs',
      key: 'skillsDir',
      value: skillRootWithTrailingSlash(opts.skillRoot),
      source: { file: 'apex-skills.lock.json' },
    };
  }

  const adapterDir = pkgAdapterDir(pkgRoot, skill);
  const templateRels = listFilesRel(adapterDir).filter((f) => f !== RECIPE_NAME);

  const files = {};
  const explainByFile = {};
  for (const rel of templateRels) {
    const raw = normalizeText(fs.readFileSync(path.join(adapterDir, rel), 'utf8'));
    // apex-skill.json and other JSON contracts are copied verbatim (no slots).
    if (rel.endsWith('.json')) {
      files[rel] = raw;
      continue;
    }
    const { text, explain } = renderTemplate(raw, recipe, idx);
    let finalText = text;
    if (enrich && typeof enricher === 'function' && hasTodos(explain) === false) {
      // Stage C only polishes prose within evidence bounds; never fills TODOs.
      finalText = normalizeText(enricher(text, { skill, evidence: idx }));
    }
    files[rel] = finalText;
    explainByFile[rel] = explain;
  }

  return {
    files,
    explain: explainByFile,
    meta: { ...meta, enriched: Boolean(enrich && enricher), templateFiles: templateRels.length },
  };
}
