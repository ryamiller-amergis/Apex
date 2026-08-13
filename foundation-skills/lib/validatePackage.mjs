/**
 * Validate the foundation-skills package itself:
 *  - catalog structural validity + coverage (catalog <-> folders)
 *  - each foundation SKILL.md has valid kebab frontmatter
 *  - each adapter has a valid apex-skill.json contract with a supported apiVersion
 *  - no unresolved slot directives reference unknown detectors
 *  - no-project-context lint: foundation files must not mention foreign projects
 *  - every nested supporting file has a declared owner in the catalog
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, listFilesRel } from './util.mjs';
import { loadCatalog, validateCatalog } from './catalog.mjs';
import { validateContract } from './contract.mjs';
import { DETECTORS } from './detectors.mjs';
import { validateAgentSkillDocument } from './agentSkillValidation.mjs';

// Foreign-project identifiers that must never appear in a generic foundation.
const FOREIGN_TOKENS = [
  /maxview/i,
  /recruitcare/i,
  /timeclock/i,
  /\berecruit\b/i,
];

const NON_RUNTIME_FILES = new Set(['recipe.json']);

export function validatePackage(pkgRoot) {
  const errors = [];
  const warnings = [];

  let catalog;
  try {
    catalog = loadCatalog(pkgRoot);
  } catch (e) {
    return { ok: false, errors: [`Cannot load catalog.json: ${e.message}`], warnings };
  }

  errors.push(...validateCatalog(catalog));

  const foundationRoot = path.join(pkgRoot, 'foundation');
  const adaptersRoot = path.join(pkgRoot, 'adapters');
  const runtimeFilesBySkill = buildRuntimeFilesBySkill(catalog);
  const knownRuntimeFiles = new Set(
    [...runtimeFilesBySkill.values()].flatMap((files) => [...files]),
  );

  const foundationDirs = listDirs(foundationRoot);
  const adapterDirs = listDirs(adaptersRoot);
  const catalogNames = new Set((catalog.skills ?? []).map((s) => s.name));

  // Coverage: every folder must be catalogued and vice versa.
  for (const d of foundationDirs) {
    if (!catalogNames.has(d)) errors.push(`foundation/${d} is not listed in catalog.json`);
  }
  for (const name of catalogNames) {
    if (!foundationDirs.includes(name)) errors.push(`catalog skill "${name}" has no foundation/${name} directory`);
    if (!adapterDirs.includes(name)) errors.push(`catalog skill "${name}" has no adapters/${name} directory`);
  }

  for (const skill of catalog.skills ?? []) {
    const fDir = path.join(foundationRoot, skill.name);
    const aDir = path.join(adaptersRoot, skill.name);
    const skillRuntimeFiles = runtimeFilesBySkill.get(skill.name) ?? new Set();
    const declaredDeps = [...new Set(skill.dependsOn ?? [])].sort();
    let contract = null;

    // Agent Skills specification + no-project-context lint.
    for (const [layer, skillPath] of [
      ['foundation', path.join(fDir, 'SKILL.md')],
      ['adapters', path.join(aDir, 'SKILL.md')],
    ]) {
      if (!fs.existsSync(skillPath)) {
        errors.push(`${layer}/${skill.name}/SKILL.md is missing`);
        continue;
      }
      const validation = validateAgentSkillDocument(
        fs.readFileSync(skillPath, 'utf8'),
        { expectedName: skill.name }
      );
      errors.push(
        ...validation.errors.map(
          (error) => `${layer}/${skill.name}/SKILL.md ${error}`
        )
      );
      warnings.push(
        ...validation.warnings.map(
          (warning) => `${layer}/${skill.name}/SKILL.md ${warning}`
        )
      );
    }

    for (const rel of listFilesRel(fDir)) {
      const abs = path.join(fDir, rel);
      const text = fs.readFileSync(abs, 'utf8');
      for (const tok of FOREIGN_TOKENS) {
        if (tok.test(text)) {
          errors.push(
            `foundation/${skill.name}/${rel} contains foreign-project reference matching ${tok}`
          );
          break;
        }
      }
    }

    // Adapter contract.
    const contractPath = path.join(aDir, 'apex-skill.json');
    if (!fs.existsSync(contractPath)) {
      errors.push(`adapters/${skill.name}/apex-skill.json is missing`);
    } else {
      try {
        contract = readJson(contractPath);
        errors.push(...validateContract(contract, { skillName: skill.name }));
      } catch (e) {
        errors.push(`adapters/${skill.name}/apex-skill.json invalid JSON: ${e.message}`);
      }
    }

    if (declaredDeps.length > 0 && contract?.dependsOn === undefined) {
      errors.push(
        `adapters/${skill.name}/apex-skill.json must declare dependsOn ${formatList(declaredDeps)} `
        + `because catalog dependsOn is non-empty`,
      );
    } else if (contract?.dependsOn !== undefined) {
      const contractDeps = normalizeDeps(contract.dependsOn);
      if (!contractDeps) {
        errors.push(`adapters/${skill.name}/apex-skill.json dependsOn must be an array of skill names`);
      } else if (!sameArray(contractDeps, declaredDeps)) {
        errors.push(
          `adapters/${skill.name}/apex-skill.json contract dependsOn ${formatList(contractDeps)} `
          + `does not match catalog dependsOn ${formatList(declaredDeps)}`,
        );
      }
    }

    // Recipe detector references + supporting-file owners.
    const recipePath = path.join(aDir, 'recipe.json');
    if (fs.existsSync(recipePath)) {
      try {
        const recipe = readJson(recipePath);
        for (const det of recipe.detectors ?? []) {
          if (!DETECTORS[det]) errors.push(`adapters/${skill.name}/recipe.json references unknown detector "${det}"`);
        }
      } catch (e) {
        errors.push(`adapters/${skill.name}/recipe.json invalid JSON: ${e.message}`);
      }
    }

    // Supporting files (non-SKILL.md) must have a declared owner.
    const owners = skill.supportingOwners ?? {};
    for (const rel of listFilesRel(fDir).concat(listFilesRel(aDir))) {
      if (rel === 'SKILL.md' || rel === 'apex-skill.json' || rel === 'recipe.json') continue;
      if (!owners[rel]) {
        warnings.push(`skill "${skill.name}" supporting file "${rel}" has no declared owner in supportingOwners`);
      }
    }

    for (const { layer, ref } of inspectSkillReferences(
      skill.name,
      fDir,
      aDir,
      knownRuntimeFiles,
      skillRuntimeFiles,
      catalogNames,
    )) {
      if (ref.skill === skill.name) {
        if (!skillRuntimeFiles.has(ref.file)) {
          errors.push(
            `${layer}/${skill.name}/SKILL.md references sibling runtime asset "${ref.file}" `
            + `but it is missing from the packaged manifest`,
          );
          continue;
        }
        if (!skillFileExists(fDir, aDir, ref.file)) {
          errors.push(
            `${layer}/${skill.name}/SKILL.md references sibling runtime asset "${ref.file}" `
            + `but ${skill.name}/${ref.file} is missing on disk`,
          );
        }
        continue;
      }

      const targetFiles = runtimeFilesBySkill.get(ref.skill);
      if (!targetFiles) {
        errors.push(
          `${layer}/${skill.name}/SKILL.md references unknown skill runtime "${ref.skill}/${ref.file}"`,
        );
        continue;
      }
      if (!declaredDeps.includes(ref.skill)) {
        errors.push(
          `${layer}/${skill.name}/SKILL.md references hard dependency "${ref.skill}/${ref.file}" `
          + `but catalog dependsOn is missing "${ref.skill}"`,
        );
        continue;
      }
      if (!targetFiles.has(ref.file)) {
        errors.push(
          `${layer}/${skill.name}/SKILL.md references "${ref.skill}/${ref.file}" `
          + `but that runtime file is missing from the dependency manifest`,
        );
        continue;
      }
      if (!skillFileExists(
        path.join(foundationRoot, ref.skill),
        path.join(adaptersRoot, ref.skill),
        ref.file,
      )) {
        errors.push(
          `${layer}/${skill.name}/SKILL.md references "${ref.skill}/${ref.file}" `
          + `but that runtime file is missing on disk`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function listDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

function buildRuntimeFilesBySkill(catalog) {
  const bySkill = new Map();
  for (const skill of catalog.skills ?? []) {
    const runtimeFiles = new Set(
      [...(skill.foundationFiles ?? []), ...(skill.adapterFiles ?? [])].filter(
        (rel) => !NON_RUNTIME_FILES.has(rel),
      ),
    );
    bySkill.set(skill.name, runtimeFiles);
  }
  return bySkill;
}

function inspectSkillReferences(
  skillName,
  foundationDir,
  adapterDir,
  knownRuntimeFiles,
  localRuntimeFiles,
  catalogNames,
) {
  const refs = [];
  for (const [layer, dir] of [['foundation', foundationDir], ['adapters', adapterDir]]) {
    const skillPath = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const text = fs.readFileSync(skillPath, 'utf8');
    for (const ref of extractRuntimeRefs(
      text,
      skillName,
      knownRuntimeFiles,
      localRuntimeFiles,
      catalogNames,
    )) {
      refs.push({ layer, ref });
    }
  }
  return refs;
}

function extractRuntimeRefs(
  text,
  skillName,
  knownRuntimeFiles,
  localRuntimeFiles,
  catalogNames,
) {
  if (!text || knownRuntimeFiles.size === 0) return [];

  const refs = [];
  const seen = new Set();
  const filePattern = [...knownRuntimeFiles]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

  const addRef = (
    targetSkill,
    file,
    matchIndex,
    matchLength,
    { suppressible = false } = {}
  ) => {
    if (!targetSkill || !file || !knownRuntimeFiles.has(file)) return;
    if (
      suppressible &&
      typeof matchIndex === 'number' &&
      isSuppressedBareRuntimeRef(text, matchIndex, matchLength ?? 0)
    )
      return;
    const key = `${targetSkill}::${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ skill: targetSkill, file });
  };

  for (const match of text.matchAll(
    /\.(?:cursor|agents)\/skills\/([a-z][a-z0-9-]*)\/([A-Za-z0-9._-]+)/g
  )) {
    addRef(match[1], match[2], match.index, match[0].length);
  }

  for (const match of text.matchAll(
    /\{\{slot:skillsDir\}\}([a-z][a-z0-9-]*)\/([A-Za-z0-9._-]+)/g
  )) {
    addRef(match[1], match[2], match.index, match[0].length);
  }

  // Sibling hops (`../other-skill/file`) only count when `other-skill` is a
  // catalog skill — prose like `../docs/readme.md` must not misfire. Cross-skill
  // runtime files still require catalog `dependsOn` (or a duplicated companion).
  for (const match of text.matchAll(
    /\.\.\/([a-z][a-z0-9-]*)\/([A-Za-z0-9._-]+)/g
  )) {
    if (!catalogNames?.has(match[1])) continue;
    addRef(match[1], match[2], match.index, match[0].length);
  }

  const skillBoundaryBefore = '(^|[\\s`"\\\'(])';
  const skillBoundaryAfter = '(?=$|[\\s`"\\\',.)])';
  const skillPathPattern = new RegExp(
    `${skillBoundaryBefore}([a-z][a-z0-9-]*)\\/(${filePattern})${skillBoundaryAfter}`,
    'gm',
  );
  for (const match of text.matchAll(skillPathPattern)) {
    addRef(match[2], match[3], match.index, match[0].length, { suppressible: true });
  }

  const localFilePattern = [...localRuntimeFiles]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  if (!localFilePattern) return refs;

  const localPattern = new RegExp('`(' + localFilePattern + ')`', 'g');
  for (const match of text.matchAll(localPattern)) {
    addRef(skillName, match[1], match.index, match[0].length, { suppressible: true });
  }

  return refs;
}

function skillFileExists(foundationDir, adapterDir, rel) {
  return fs.existsSync(path.join(foundationDir, rel)) || fs.existsSync(path.join(adapterDir, rel));
}

function normalizeDeps(deps) {
  if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== 'string')) return null;
  return [...new Set(deps)].sort();
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function formatList(values) {
  return `[${values.join(', ')}]`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSuppressedBareRuntimeRef(text, matchIndex, matchLength) {
  const lineStart = text.lastIndexOf('\n', matchIndex) + 1;
  const nextNewline = text.indexOf('\n', matchIndex);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const line = text.slice(lineStart, lineEnd);
  const relativeStart = matchIndex - lineStart;
  const relativeEnd = relativeStart + matchLength;
  const before = line.slice(Math.max(0, relativeStart - 48), relativeStart).toLowerCase();
  const after = line.slice(relativeEnd, Math.min(line.length, relativeEnd + 48)).toLowerCase();
  const context = `${before} ${after}`;

  return (
    /\(if present\)/i.test(after)
    || /\boptional\b/i.test(context)
    || /\bwhen available\b/i.test(context)
    || /\.ai-pilot\/output\//i.test(line)
  );
}
