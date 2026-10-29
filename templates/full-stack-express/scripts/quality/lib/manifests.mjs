import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';

export const QUALITY_MANIFEST = 'quality/quality-manifest.json';
export const QUALITY_SCHEMA = 'quality/quality-manifest.schema.json';
export const NFR_MANIFEST = 'quality/nfr-manifest.json';
export const NFR_SCHEMA = 'quality/nfr-manifest.schema.json';
export const SHARED_FLOORS = 'packages/config/testing.mjs';
export const CONFIG_PACKAGE = 'packages/config/package.json';

export const CORE_GATES = Object.freeze([
  'build',
  'type-check',
  'lint',
  'formatting',
  'openapi-drift',
  'migration-validation',
  'unit',
  'component',
  'api',
  'integration',
  'accessibility',
  'container-build',
]);

const FLOOR_KEYS = ['lines', 'functions', 'statements', 'branches'];
const TARGET_KEYS = ['responseTime', 'concurrency', 'dataVolume'];
const VITEST_CONFIG = /^vitest.*\.config\.[cm]?[jt]s$/;

/**
 * @typedef {{ file: string, path: string, message: string }} Finding
 * @typedef {{ id: string, status: 'defined' | 'deferred', script: string }} GateRow
 * @typedef {{ gate: string, owner: string, reason: string }} DeferralRow
 * @typedef {{ target: string, value: string, illustrative: boolean, verifiedBy: string }} TraceRow
 */

/**
 * Checks both manifests against their schemas and the workspace. Reads only
 * paths under `root`, prints nothing, and never runs a gate script. Messages
 * name the file, JSON path, and rule, never the rejected value.
 *
 * @param {string} root
 * @returns {Promise<{ errors: Finding[], warnings: Finding[], summary: { gates: GateRow[], deferrals: DeferralRow[], targets: TraceRow[] }, nfr: unknown }>}
 */
export async function validateManifests(root) {
  const errors = [];
  const warnings = [];
  const error = (file, at, message) =>
    errors.push({ file, path: at || '/', message });
  const warn = (file, at, message) =>
    warnings.push({ file, path: at || '/', message });

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const summary = { gates: [], deferrals: [], targets: [] };

  const quality = readJson(root, QUALITY_MANIFEST, error);
  const qualitySchema = readJson(root, QUALITY_SCHEMA, error);
  if (quality.ok && qualitySchema.ok) {
    for (const finding of schemaFindings(
      ajv,
      qualitySchema.value,
      quality.value
    )) {
      if (isDeferralTextError(finding)) {
        continue;
      }
      error(QUALITY_MANIFEST, finding.path, finding.message);
    }
    await checkQuality(root, quality.value, summary, error, warn);
  }

  const nfr = readJson(root, NFR_MANIFEST, error);
  const nfrSchema = readJson(root, NFR_SCHEMA, error);
  if (nfr.ok && nfrSchema.ok) {
    for (const finding of schemaFindings(ajv, nfrSchema.value, nfr.value)) {
      error(NFR_MANIFEST, finding.path, finding.message);
    }
    checkNfr(root, nfr.value, summary, error, warn);
  }

  return { errors, warnings, summary, nfr: nfr.ok ? nfr.value : undefined };
}

function readJson(root, relative, error) {
  const full = path.join(root, relative);
  if (!existsSync(full)) {
    error(relative, '/', 'required file is missing');
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(readFileSync(full, 'utf8')) };
  } catch {
    error(relative, '/', 'is not valid JSON');
    return { ok: false };
  }
}

function schemaFindings(ajv, schema, value) {
  const validate = ajv.compile(schema);
  if (validate(value)) {
    return [];
  }
  return (validate.errors ?? []).map((issue) => ({
    keyword: issue.keyword,
    params: issue.params,
    path: issue.instancePath,
    message: describeSchemaError(issue),
  }));
}

function describeSchemaError(issue) {
  switch (issue.keyword) {
    case 'additionalProperties':
      return `unknown property "${issue.params.additionalProperty}" is not allowed`;
    case 'required':
      return `missing required field "${issue.params.missingProperty}"`;
    case 'type':
      return `must be ${issue.params.type}`;
    case 'const':
      return `must equal ${JSON.stringify(issue.params.allowedValue)}`;
    case 'pattern':
      return issue.params.pattern === '\\S'
        ? 'must contain a non-space character'
        : `must match ${issue.params.pattern}`;
    default:
      return issue.message ?? `breaks the "${issue.keyword}" rule`;
  }
}

// Q8 reports blank or missing deferral text with the deferral's gate.
function isDeferralTextError(finding) {
  if (/^\/deferrals\/\d+\/(reason|owner)$/.test(finding.path)) {
    return true;
  }
  return (
    finding.keyword === 'required' &&
    /^\/deferrals\/\d+$/.test(finding.path) &&
    ['reason', 'owner'].includes(finding.params.missingProperty)
  );
}

function isText(value) {
  return typeof value === 'string' && /\S/.test(value);
}

async function checkQuality(root, manifest, summary, error, warn) {
  const file = QUALITY_MANIFEST;
  const gates = Array.isArray(manifest?.gates) ? manifest.gates : [];
  const deferrals = Array.isArray(manifest?.deferrals)
    ? manifest.deferrals
    : [];

  const gateIds = new Map();
  gates.forEach((gate, index) => {
    if (typeof gate?.id !== 'string') {
      return;
    }
    if (gateIds.has(gate.id)) {
      error(file, `/gates/${index}/id`, `duplicate gate id "${gate.id}"`);
      return;
    }
    gateIds.set(gate.id, index);
  });

  for (const id of CORE_GATES) {
    if (!gateIds.has(id)) {
      error(file, '/gates', `required gate "${id}" is missing`);
    }
  }

  const completeDeferrals = new Map();
  const deferralGates = new Set();
  deferrals.forEach((deferral, index) => {
    const at = `/deferrals/${index}`;
    const gate = typeof deferral?.gate === 'string' ? deferral.gate : '';
    const label = gate ? ` for gate "${gate}"` : '';
    if (gate && deferralGates.has(gate)) {
      error(file, `${at}/gate`, `gate "${gate}" has more than one deferral`);
    }
    if (gate) {
      deferralGates.add(gate);
    }
    if (gate && !gateIds.has(gate)) {
      error(
        file,
        `${at}/gate`,
        `deferral ${index} names unknown gate "${gate}"`
      );
    }
    let complete = Boolean(gate);
    for (const field of ['reason', 'owner']) {
      if (!isText(deferral?.[field])) {
        complete = false;
        error(
          file,
          `${at}/${field}`,
          `deferral ${index}${label} needs a non-blank ${field}`
        );
      }
    }
    if (complete && gateIds.has(gate)) {
      completeDeferrals.set(gate, deferral);
    }
    summary.deferrals.push({
      gate,
      owner: isText(deferral?.owner) ? deferral.owner : '',
      reason: isText(deferral?.reason) ? deferral.reason : '',
    });
  });

  const scripts = readScripts(root, error);
  gates.forEach((gate, index) => {
    if (typeof gate?.id !== 'string' || gateIds.get(gate.id) !== index) {
      return;
    }
    const script = typeof gate.script === 'string' ? gate.script : '';
    const deferred = completeDeferrals.has(gate.id);
    if (scripts && script && !Object.hasOwn(scripts, script)) {
      const message = `gate "${gate.id}" names script "${script}", which is not in package.json scripts`;
      if (deferred) {
        warn(file, `/gates/${index}/script`, `${message} (gate is deferred)`);
      } else {
        error(file, `/gates/${index}/script`, message);
      }
    }
    summary.gates.push({
      id: gate.id,
      status: deferred ? 'deferred' : 'defined',
      script,
    });
  });

  await checkFloors(root, manifest?.coverage, error);
  checkMemberConfigs(root, error);
}

function readScripts(root, error) {
  const full = path.join(root, 'package.json');
  if (!existsSync(full)) {
    error('package.json', '/', 'required file is missing');
    return undefined;
  }
  try {
    const scripts = JSON.parse(readFileSync(full, 'utf8')).scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch {
    error('package.json', '/', 'is not valid JSON');
    return undefined;
  }
}

async function checkFloors(root, coverage, error) {
  const full = path.join(root, SHARED_FLOORS);
  if (!existsSync(full)) {
    error(
      SHARED_FLOORS,
      '/',
      'required file is missing; it defines the shared coverage floors'
    );
    return;
  }
  let shared;
  try {
    shared = (await import(pathToFileURL(full).href)).coverageFloors;
  } catch {
    error(SHARED_FLOORS, '/', 'could not be loaded');
    return;
  }
  if (!shared || typeof shared !== 'object') {
    error(SHARED_FLOORS, '/', 'does not export coverageFloors');
    return;
  }
  if (!coverage || typeof coverage !== 'object') {
    return;
  }
  for (const key of FLOOR_KEYS) {
    const listed = coverage[key];
    if (typeof listed !== 'number') {
      continue;
    }
    if (listed !== shared[key]) {
      error(
        QUALITY_MANIFEST,
        `/coverage/${key}`,
        `${key} is ${listed} here and ${shared[key]} in ${SHARED_FLOORS}`
      );
    }
  }
}

function checkMemberConfigs(root, error) {
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceFile)) {
    error('pnpm-workspace.yaml', '/', 'required file is missing');
    return;
  }
  let patterns;
  try {
    patterns = parseYaml(readFileSync(workspaceFile, 'utf8'))?.packages;
  } catch {
    error('pnpm-workspace.yaml', '/', 'is not valid YAML');
    return;
  }
  const configName = readConfigPackageName(root);
  if (!configName) {
    error(CONFIG_PACKAGE, '/name', 'the shared config package needs a name');
    return;
  }
  for (const member of memberDirs(
    root,
    Array.isArray(patterns) ? patterns : []
  )) {
    const ownName = readPackageName(path.join(member, 'package.json'));
    for (const name of readdirSync(member)) {
      if (!VITEST_CONFIG.test(name)) {
        continue;
      }
      const relative = path
        .relative(root, path.join(member, name))
        .split(path.sep)
        .join('/');
      const text = readFileSync(path.join(member, name), 'utf8');
      if (/\bthresholds\b/.test(text)) {
        error(
          relative,
          '/',
          'sets thresholds and does not use the shared floors'
        );
      }
      if (ownName !== configName && !text.includes(configName)) {
        error(
          relative,
          '/',
          `does not import ${configName}, so it does not use the shared floors`
        );
      }
    }
  }
}

function readConfigPackageName(root) {
  return readPackageName(path.join(root, CONFIG_PACKAGE));
}

function readPackageName(file) {
  try {
    const name = JSON.parse(readFileSync(file, 'utf8')).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

function memberDirs(root, patterns) {
  const dirs = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.startsWith('!')) {
      continue;
    }
    if (pattern.endsWith('/*')) {
      const parent = path.join(root, pattern.slice(0, -2));
      if (!isDir(parent)) {
        continue;
      }
      for (const name of readdirSync(parent).sort()) {
        const dir = path.join(parent, name);
        if (isDir(dir) && existsSync(path.join(dir, 'package.json'))) {
          dirs.push(dir);
        }
      }
    } else {
      const dir = path.join(root, pattern);
      if (isDir(dir)) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

function isDir(full) {
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function checkNfr(root, manifest, summary, error, warn) {
  const file = NFR_MANIFEST;
  const targets =
    manifest?.targets && typeof manifest.targets === 'object'
      ? manifest.targets
      : {};
  let illustrativeCount = 0;
  for (const key of TARGET_KEYS) {
    const target = targets[key];
    if (!target || typeof target !== 'object') {
      continue;
    }
    const at = `/targets/${key}`;
    if (isText(target.verifiedBy)) {
      const resolved = path.resolve(root, target.verifiedBy);
      const inside = !path
        .relative(path.resolve(root), resolved)
        .startsWith('..');
      if (!inside) {
        error(
          file,
          `${at}/verifiedBy`,
          `target "${key}" points outside the template root`
        );
      } else if (!existsSync(resolved)) {
        error(
          file,
          `${at}/verifiedBy`,
          `target "${key}" names load-test definition "${target.verifiedBy}", which does not exist`
        );
      }
    }
    if (target.illustrative === true) {
      illustrativeCount += 1;
      warn(
        file,
        `${at}/illustrative`,
        `target "${key}" uses an illustrative example value`
      );
    }
    summary.targets.push({
      target: key,
      value: describeTarget(key, target),
      illustrative: target.illustrative === true,
      verifiedBy:
        typeof target.verifiedBy === 'string' ? target.verifiedBy : '',
    });
  }
  if (illustrativeCount === TARGET_KEYS.length) {
    warn(
      file,
      '/targets',
      'the project has not set real NFR targets; every target is an illustrative example'
    );
  }
}

function describeTarget(key, target) {
  if (key === 'responseTime') {
    return `p${target.percentile} <= ${target.maxMs} ms`;
  }
  if (key === 'concurrency') {
    return `${target.users} users`;
  }
  return `${target.rows} rows in ${target.table}`;
}
