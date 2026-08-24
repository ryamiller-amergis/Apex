/**
 * apex-skill.json compatibility contract — the machine-readable declaration
 * that makes adapter/foundation updates deterministic.
 *
 * {
 *   "apiVersion": 1,
 *   "skill": "ui-lab",
 *   "foundation": { "package": "@apex/skills", "range": ">=0.1.0" },
 *   "managedFiles": ["SKILL.md"],
 *   "extensionFiles": ["SKILL.md"],
 *   "capabilities": ["design-tokens", "component-index"]
 * }
 *
 * `managedFiles` paths are relative to <skillRoot>/<skill>/ in the consumer
 * repo (and to foundation/<skill>/ + adapter extras in the package).
 *
 * Legacy `managedFoundationFiles` is still accepted and normalized.
 */
import { CONTRACT_API_VERSION } from './layout.mjs';
import { isValid, satisfies } from './semver.mjs';

export function validateContract(contract, { skillName } = {}) {
  const errors = [];
  if (!contract || typeof contract !== 'object') return ['apex-skill.json is not an object'];

  if (contract.apiVersion !== CONTRACT_API_VERSION) {
    errors.push(`unsupported contract apiVersion ${contract.apiVersion} (expected ${CONTRACT_API_VERSION})`);
  }
  if (!contract.skill) errors.push('contract.skill is required');
  if (skillName && contract.skill && contract.skill !== skillName) {
    errors.push(`contract.skill "${contract.skill}" does not match "${skillName}"`);
  }
  if (!contract.foundation || typeof contract.foundation !== 'object') {
    errors.push('contract.foundation is required');
  } else {
    if (!contract.foundation.package) errors.push('contract.foundation.package is required');
    if (!contract.foundation.range) errors.push('contract.foundation.range is required');
  }

  const managed = normalizeManagedFiles(contract);
  if (!Array.isArray(managed)) {
    errors.push('contract.managedFiles must be an array (or legacy managedFoundationFiles)');
  }

  return errors;
}

/**
 * Return adapter-relative managed file paths from a contract, normalizing
 * legacy `.apex/foundation/<skill>/…` entries to bare filenames.
 */
export function normalizeManagedFiles(contract) {
  const raw = contract?.managedFiles ?? contract?.managedFoundationFiles;
  if (!Array.isArray(raw)) return null;
  return raw.map((p) => {
    if (typeof p !== 'string') return p;
    // ".apex/foundation/to-prd/SKILL.md" → "SKILL.md"
    const m = p.match(/^\.apex\/foundation\/[^/]+\/(.+)$/);
    if (m) return m[1];
    // Already adapter-relative
    return p.replace(/^\.\//, '');
  });
}

/** Is the given suite version compatible with the contract's foundation range? */
export function contractSatisfiedBy(contract, suiteVersion) {
  if (!contract?.foundation?.range) return false;
  if (!isValid(suiteVersion)) return false;
  return satisfies(suiteVersion, contract.foundation.range);
}
