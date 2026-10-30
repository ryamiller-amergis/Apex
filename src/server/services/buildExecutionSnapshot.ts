import { BUILD_TASK_ROLES } from '../../shared/types/build';
import type {
  BuildLaunchRefusal,
  BuildLaunchRefusalCode,
  BuildLaunchSnapshot,
} from '../../shared/types/buildLaunchSnapshot';
import { findSecretClasses } from './buildRedactionService';

export interface SecretValueDetector {
  /** Any secret pattern or held secret value. */
  containsSecret(text: string): boolean;
  /** Exact held secret values only. */
  containsHeldSecretValue(text: string): boolean;
}

export type BuildLaunchSnapshotValidation =
  | { ok: true; snapshot: BuildLaunchSnapshot }
  | { ok: false; refusals: BuildLaunchRefusal[] };

const MIN_HELD_SECRET_CHARS = 8;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SECRET_REF = /^app-setting:[A-Z0-9_]+$/;
const MAX_PARALLELISM = 6;
const REDACTED_KEY_SEGMENT = '[redacted-key]';

/** Pattern check from the build redaction step, plus exact held values. */
export function createSecretValueDetector(heldSecrets: readonly string[]): SecretValueDetector {
  const held = [...new Set(heldSecrets.filter((value) => value.length >= MIN_HELD_SECRET_CHARS))];
  const containsHeldSecretValue = (text: string) => held.some((value) => text.includes(value));
  return {
    containsSecret: (text) => findSecretClasses(text).length > 0 || containsHeldSecretValue(text),
    containsHeldSecretValue,
  };
}

type Rule =
  | { kind: 'string' }
  | { kind: 'literal'; value: string | number | boolean; invalidCode?: BuildLaunchRefusalCode }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'positiveNumber' }
  | { kind: 'integer'; min: number; max?: number }
  | { kind: 'hash' }
  | { kind: 'secretRef' }
  | { kind: 'object'; fields: Readonly<Record<string, Rule>> }
  | { kind: 'array'; item: Rule; minItems: number };

const text: Rule = { kind: 'string' };
const hash: Rule = { kind: 'hash' };
const filePointer: Rule = { kind: 'object', fields: { path: text, contentHash: hash } };
const blobPointer = { container: text, key: text, contentHash: hash } as const;

const SNAPSHOT_RULE: Rule = {
  kind: 'object',
  fields: {
    schemaVersion: { kind: 'literal', value: 1 },
    buildRunId: text,
    buildRevisionId: text,
    buildTaskId: text,
    taskKey: text,
    role: { kind: 'enum', values: BUILD_TASK_ROLES },
    attempt: { kind: 'integer', min: 1 },
    model: text,
    skill: filePointer,
    standards: {
      kind: 'object',
      fields: { designSystem: filePointer, codingRules: filePointer, codeMap: filePointer },
    },
    prompt: { kind: 'object', fields: blobPointer },
    context: {
      kind: 'array',
      minItems: 1,
      item: { kind: 'object', fields: { ...blobPointer, label: text } },
    },
    repository: {
      kind: 'object',
      fields: {
        provider: { kind: 'enum', values: ['ado', 'github'] },
        project: text,
        repo: text,
        defaultBranch: text,
      },
    },
    startingBranch: text,
    targetBranch: text,
    pullRequest: {
      kind: 'object',
      fields: { open: { kind: 'literal', value: false, invalidCode: 'pull_request_not_allowed' } },
    },
    caps: {
      kind: 'object',
      fields: {
        costUsd: { kind: 'positiveNumber' },
        elapsedMs: { kind: 'integer', min: 1 },
        revisions: { kind: 'integer', min: 1 },
        parallelism: { kind: 'integer', min: 1, max: MAX_PARALLELISM },
      },
    },
    secretRefs: { kind: 'array', minItems: 0, item: { kind: 'secretRef' } },
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function checkRule(rule: Rule, value: unknown, path: string, refusals: BuildLaunchRefusal[]): void {
  const invalid = (code: BuildLaunchRefusalCode = 'snapshot_field_invalid') => {
    refusals.push(path ? { code, fieldPath: path } : { code });
  };
  switch (rule.kind) {
    case 'string':
      if (typeof value !== 'string' || value.trim() === '') invalid();
      return;
    case 'literal':
      if (value !== rule.value) invalid(rule.invalidCode);
      return;
    case 'enum':
      if (typeof value !== 'string' || !rule.values.includes(value)) invalid();
      return;
    case 'positiveNumber':
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) invalid();
      return;
    case 'integer':
      if (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < rule.min
        || (rule.max !== undefined && value > rule.max)
      ) invalid();
      return;
    case 'hash':
      if (typeof value !== 'string' || !SHA256_HEX.test(value)) invalid();
      return;
    case 'secretRef':
      if (typeof value !== 'string' || !SECRET_REF.test(value)) invalid();
      return;
    case 'object': {
      if (!isPlainObject(value)) {
        invalid();
        return;
      }
      for (const [key, childRule] of Object.entries(rule.fields)) {
        const child = childPath(path, key);
        if (!(key in value) || value[key] === undefined || value[key] === null) {
          refusals.push({ code: 'snapshot_field_missing', fieldPath: child });
          continue;
        }
        checkRule(childRule, value[key], child, refusals);
      }
      for (const key of Object.keys(value)) {
        if (!(key in rule.fields)) {
          refusals.push({ code: 'snapshot_unknown_field', fieldPath: childPath(path, key) });
        }
      }
      return;
    }
    case 'array':
      if (!Array.isArray(value) || value.length < rule.minItems) {
        invalid();
        return;
      }
      value.forEach((item, index) => checkRule(rule.item, item, `${path}[${index}]`, refusals));
      return;
    default: {
      const unreachable: never = rule;
      throw new Error(`Unhandled snapshot rule: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Walks every key name and string value, including unknown keys. */
function scanForSecrets(
  value: unknown,
  path: string,
  detector: SecretValueDetector,
  refusals: BuildLaunchRefusal[],
): void {
  if (typeof value === 'string') {
    if (detector.containsSecret(value)) refusals.push({ code: 'snapshot_secret_value', fieldPath: path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForSecrets(item, `${path}[${index}]`, detector, refusals));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const secretKey = detector.containsSecret(key);
      const keyPath = childPath(path, secretKey ? REDACTED_KEY_SEGMENT : key);
      if (secretKey) refusals.push({ code: 'snapshot_secret_value', fieldPath: keyPath });
      scanForSecrets(child, keyPath, detector, refusals);
    }
  }
}

/**
 * Closed schema: every field is required and an unknown key refuses.
 * Refusals carry a code and field path, never the offending value.
 */
export function validateBuildLaunchSnapshot(
  candidate: unknown,
  ctx: { expectedProjectId: string; detector: SecretValueDetector },
): BuildLaunchSnapshotValidation {
  if (candidate === null || candidate === undefined) {
    return { ok: false, refusals: [{ code: 'snapshot_missing' }] };
  }

  const refusals: BuildLaunchRefusal[] = [];
  // Schema paths are built from raw key names, so stop here when a key may hold a secret.
  scanForSecrets(candidate, '', ctx.detector, refusals);
  if (refusals.length > 0) return { ok: false, refusals };
  checkRule(SNAPSHOT_RULE, candidate, '', refusals);
  if (refusals.length > 0) return { ok: false, refusals };

  const snapshot = candidate as BuildLaunchSnapshot;
  if (snapshot.repository.project !== ctx.expectedProjectId) {
    refusals.push({ code: 'project_mismatch', fieldPath: 'repository.project' });
  }
  if (snapshot.targetBranch.trim() === snapshot.repository.defaultBranch.trim()) {
    refusals.push({ code: 'target_is_default_branch', fieldPath: 'targetBranch' });
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, snapshot };
}
