/**
 * Bootstrapper — 3-stage deterministic adapter pre-fill pipeline
 *
 * Stage A: Evidence collection (deterministic, no LLM)
 *   Run detectors defined in the skill's bootstrap-recipe.json.
 *   Every fact carries a `file` (and optional `line`) source.
 *
 * Stage B: Slot templating (deterministic)
 *   Read the adapter template, fill named {{SLOT}} placeholders from evidence.
 *   Unfilled slots become "TODO: <slot description>" rather than empty.
 *
 * Stage C: AI enrichment (optional, opt-in, default OFF)
 *   If --enrich is set, improve prose within evidence bounds at temperature 0.
 *   Always marks generated sections as "<!-- APEX-GENERATED-DRAFT -->".
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { runDetectors } from './detectors/index.mjs';
import { FOUNDATION_DIR, toPosix } from './paths.mjs';
import { readLockfile } from './lockfile.mjs';
import { resolveRepoSkillRoot } from './skillRoot.mjs';

/** Load a skill's bootstrap recipe from its foundation directory. */
function loadRecipe(skillId) {
  const p = join(FOUNDATION_DIR, skillId, 'bootstrap-recipe.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

/** Load the adapter template from the skill's foundation directory. */
function loadAdapterTemplate(skillId) {
  const p = join(FOUNDATION_DIR, skillId, 'adapter-template.md');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}

/**
 * Stage A: run detectors for a given recipe and return evidence.json object.
 * @returns {{ facts: Array, meta: { cappedDetectors: string[], fileCount: number } }}
 */
async function collectEvidence(recipe, repoRoot, { capMs = 45_000, onProgress } = {}) {
  const scope = recipe?.detectors ?? null; // null = run all
  const evidenceMap = await runDetectors(repoRoot, { scope, capMs, onProgress });
  const facts = Object.values(evidenceMap).flat();
  const cappedDetectors = Object.entries(evidenceMap)
    .filter(([, arr]) => arr.length === 0 && scope?.includes(arr))
    .map(([k]) => k);
  return { facts, meta: { cappedDetectors, fileCount: facts.length } };
}

/**
 * Stage B: fill template slots from evidence facts.
 * Slots use the syntax: {{SLOT_NAME:Description of expected content}}
 * or just {{SLOT_NAME}}.
 *
 * @param {string} template  - the adapter-template.md content
 * @param {object} recipe    - the bootstrap-recipe.json
 * @param {Array}  facts     - evidence from Stage A
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {boolean} [opts.explain] - collect explain entries
 * @returns {{ content: string, explains: Array, todoCount: number }}
 */
function fillSlots(template, recipe, facts, repoRoot, { explain = false } = {}) {
  const slotMap = recipe?.slots ?? {};
  const explains = [];
  let todoCount = 0;

  const content = template.replace(/\{\{([A-Z0-9_]+)(?::([^}]+))?\}\}/g, (match, slotName, desc) => {
    const mapping = slotMap[slotName];
    if (!mapping) {
      todoCount++;
      return `TODO: ${desc ?? slotName}`;
    }

    // Find matching evidence
    const { evidenceType, filter, render } = mapping;
    const matching = facts.filter(f => {
      if (f.type !== evidenceType) return false;
      if (filter) {
        for (const [k, v] of Object.entries(filter)) {
          if (f[k] !== v) return false;
        }
      }
      return true;
    });

    if (matching.length === 0) {
      todoCount++;
      return `TODO: ${desc ?? slotName} (no ${evidenceType} detected)`;
    }

    // Render the slot value
    let value;
    if (typeof render === 'string') {
      // Simple field reference: "name", "value", etc.
      value = matching.map(m => m[render]).filter(Boolean).join(', ');
    } else if (render?.type === 'list') {
      value = matching.map(m => `- ${m[render.field]}`).join('\n');
    } else if (render?.type === 'table') {
      const headers = render.columns.map(c => c.header).join(' | ');
      const sep     = render.columns.map(() => '---').join(' | ');
      const rows    = matching.map(m =>
        render.columns.map(c => String(m[c.field] ?? '')).join(' | ')
      ).join('\n');
      value = `| ${headers} |\n| ${sep} |\n${rows.split('\n').map(r => `| ${r} |`).join('\n')}`;
    } else {
      value = matching[0]?.[typeof render === 'object' ? render.field : 'value'] ?? `TODO: ${slotName}`;
    }

    if (explain) {
      const sources = matching.slice(0, 3).map(m => `${m.file}${m.line ? ':' + m.line : ''}`);
      explains.push({ slot: slotName, value, sources });
    }

    return value ?? `TODO: ${slotName}`;
  });

  return { content, explains, todoCount };
}

/**
 * Bootstrap a single skill's adapter in the target repo.
 *
 * @param {object} opts
 * @param {string}  opts.skillId
 * @param {string}  opts.repoRoot
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.explain]
 * @param {boolean} [opts.enrich]    reserved for Stage C
 * @param {number}  [opts.capMs]
 * @param {Function} [opts.onProgress]
 * @returns {{ written: boolean, adapterPath: string, todoCount: number, explains?: Array }}
 */
export async function bootstrapSkill({
  skillId,
  repoRoot,
  dryRun = false,
  explain = false,
  enrich = false,
  capMs = 45_000,
  onProgress,
  skillRoot: requestedRoot = null,
}) {
  const recipe = loadRecipe(skillId);
  const template = loadAdapterTemplate(skillId);
  if (!template) {
    return { written: false, adapterPath: null, todoCount: 0, error: 'no adapter template found' };
  }

  // Stage A — evidence collection
  const { facts, meta } = recipe
    ? await collectEvidence(recipe, repoRoot, { capMs, onProgress })
    : { facts: [], meta: { cappedDetectors: [], fileCount: 0 } };

  // Stage B — slot templating
  const { content, explains, todoCount } = fillSlots(template, recipe, facts, repoRoot, { explain });

  // Stage C — AI enrichment (opt-in, not yet integrated)
  const finalContent = enrich ? content : content; // placeholder for Stage C

  // Compute adapter output path
  const skillRoot = resolveRepoSkillRoot(repoRoot, {
    requestedRoot,
    lock: readLockfile(repoRoot),
  });
  const adapterPath = join(repoRoot, skillRoot, skillId, 'SKILL.md');

  if (!dryRun) {
    mkdirSync(dirname(adapterPath), { recursive: true });
    writeFileSync(adapterPath, finalContent, 'utf-8');
  }

  return {
    written: !dryRun,
    adapterPath: toPosix(adapterPath.replace(repoRoot + '/', '').replace(repoRoot + '\\', '')),
    todoCount,
    explains: explain ? explains : undefined,
    cappedDetectors: meta.cappedDetectors,
  };
}

/**
 * Bootstrap multiple skills.
 *
 * @param {string[]}  skillIds
 * @param {string}    repoRoot
 * @param {object}    opts
 * @returns {Array<{ skillId: string } & BootstrapResult>}
 */
export async function bootstrapAll(skillIds, repoRoot, opts = {}) {
  const results = [];
  for (const skillId of skillIds) {
    opts.onProgress?.({ skill: skillId, status: 'start' });
    const result = await bootstrapSkill({ skillId, repoRoot, ...opts });
    opts.onProgress?.({ skill: skillId, status: 'done', todoCount: result.todoCount });
    results.push({ skillId, ...result });
  }
  return results;
}
