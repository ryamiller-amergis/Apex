/**
 * apex-skill.json compatibility contract — the machine-readable declaration
 * that makes adapter/foundation updates deterministic.
 *
 * {
 *   "apiVersion": 1,
 *   "skill": "ui-lab",
 *   "foundation": { "package": "@apex/skills", "range": "^0.1.0" },
 *   "managedFoundationFiles": ["SKILL.md"],
 *   "extensionFiles": ["SKILL.md"],
 *   "capabilities": ["design-tokens", "component-index"]
 * }
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
  if (!Array.isArray(contract.managedFoundationFiles)) {
    errors.push('contract.managedFoundationFiles must be an array');
  }
  return errors;
}

/** Is the given suite version compatible with the contract's foundation range? */
export function contractSatisfiedBy(contract, suiteVersion) {
  if (!contract?.foundation?.range) return false;
  if (!isValid(suiteVersion)) return false;
  return satisfies(suiteVersion, contract.foundation.range);
}
