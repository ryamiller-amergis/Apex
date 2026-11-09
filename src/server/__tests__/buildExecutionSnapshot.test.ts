import {
  createSecretValueDetector,
  validateBuildLaunchSnapshot,
  type SecretValueDetector,
} from '../services/buildExecutionSnapshot';
import type { BuildLaunchSnapshot } from '../../shared/types/buildLaunchSnapshot';

const HASH = 'a'.repeat(64);
const HELD = 'held-secret-value-123';

function completeSnapshot(): BuildLaunchSnapshot {
  return {
    schemaVersion: 1,
    buildRunId: '11111111-1111-4111-8111-111111111111',
    buildRevisionId: '22222222-2222-4222-8222-222222222222',
    buildTaskId: '33333333-3333-4333-8333-333333333333',
    taskKey: 't1',
    role: 'implementer',
    attempt: 1,
    model: 'composer-2.5',
    skill: { path: '.cursor/skills/build-implementer/SKILL.md', contentHash: HASH },
    standards: {
      designSystem: { path: '.cursor/skills/design-system/SKILL.md', contentHash: HASH },
      codingRules: { path: '.cursor/rules/react-coding-standards.mdc', contentHash: HASH },
      codeMap: { path: '.cursor/CODEMAP.md', contentHash: HASH },
    },
    prompt: { container: 'cursor-prompts', key: 'builds/run-1/t1/1/prompt.txt', contentHash: HASH },
    context: [{ container: 'cursor-prompts', key: 'builds/run-1/brief.md', contentHash: HASH, label: 'brief' }],
    repository: { provider: 'ado', project: 'MaxView', repo: 'MaxView', defaultBranch: 'main' },
    startingBranch: 'build/run-1',
    targetBranch: 'build/run-1/t1',
    pullRequest: { open: false },
    caps: { costUsd: 25, elapsedMs: 3_600_000, revisions: 3, parallelism: 3 },
    secretRefs: ['app-setting:CURSOR_USER_LEVEL_API_KEY'],
  };
}

const quietDetector: SecretValueDetector = {
  containsSecret: () => false,
  containsHeldSecretValue: () => false,
};
const ctx = { expectedProjectId: 'MaxView', detector: createSecretValueDetector([HELD]) };

type Mutable = Record<string, unknown>;

function without(path: string): Mutable {
  const copy = JSON.parse(JSON.stringify(completeSnapshot())) as Mutable;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cursor: Mutable = copy;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Mutable;
  delete cursor[parts[parts.length - 1]];
  return copy;
}

function withValue(path: string, value: unknown): Mutable {
  const copy = without(path);
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cursor: Mutable = copy;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Mutable;
  cursor[parts[parts.length - 1]] = value;
  return copy;
}

const REQUIRED_PATHS = [
  'schemaVersion', 'buildRunId', 'buildRevisionId', 'buildTaskId', 'taskKey', 'role', 'attempt', 'model',
  'skill', 'skill.path', 'skill.contentHash',
  'standards', 'standards.designSystem', 'standards.designSystem.path', 'standards.codingRules',
  'standards.codingRules.contentHash', 'standards.codeMap', 'standards.codeMap.path',
  'prompt', 'prompt.container', 'prompt.key', 'prompt.contentHash',
  'context', 'context[0].container', 'context[0].key', 'context[0].contentHash', 'context[0].label',
  'repository', 'repository.provider', 'repository.project', 'repository.repo', 'repository.defaultBranch',
  'startingBranch', 'targetBranch', 'pullRequest', 'pullRequest.open',
  'caps', 'caps.costUsd', 'caps.elapsedMs', 'caps.revisions', 'caps.parallelism', 'secretRefs',
];

describe('validateBuildLaunchSnapshot', () => {
  it('VT-07 / DoD-3: accepts a complete snapshot', () => {
    const snapshot = completeSnapshot();

    expect(validateBuildLaunchSnapshot(snapshot, { expectedProjectId: 'MaxView', detector: quietDetector }))
      .toEqual({ ok: true, snapshot });
    expect(validateBuildLaunchSnapshot(snapshot, ctx).ok).toBe(true);
  });

  it('accepts an empty secretRefs list', () => {
    expect(validateBuildLaunchSnapshot(withValue('secretRefs', []), ctx).ok).toBe(true);
  });

  it.each([null, undefined])('DoD-0: refuses a missing snapshot (%p)', (candidate) => {
    expect(validateBuildLaunchSnapshot(candidate, ctx)).toEqual({
      ok: false,
      refusals: [{ code: 'snapshot_missing' }],
    });
  });

  it.each(REQUIRED_PATHS)('VT-08 / DoD-0: refuses when %s is missing', (path) => {
    const result = validateBuildLaunchSnapshot(without(path), ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals).toContainEqual({ code: 'snapshot_field_missing', fieldPath: path });
  });

  it.each([
    ['blank string', 'taskKey', '   ', 'snapshot_field_invalid'],
    ['parallelism above six', 'caps.parallelism', 7, 'snapshot_field_invalid'],
    ['zero cost cap', 'caps.costUsd', 0, 'snapshot_field_invalid'],
    ['negative elapsed cap', 'caps.elapsedMs', -1, 'snapshot_field_invalid'],
    ['fractional attempt', 'attempt', 1.5, 'snapshot_field_invalid'],
    ['bad hash', 'skill.contentHash', 'abc', 'snapshot_field_invalid'],
    ['unknown role', 'role', 'reviewer', 'snapshot_field_invalid'],
    ['unknown provider', 'repository.provider', 'gitlab', 'snapshot_field_invalid'],
    ['wrong schema version', 'schemaVersion', 2, 'snapshot_field_invalid'],
    ['empty context list', 'context', [], 'snapshot_field_invalid'],
    ['secret ref that is not an app setting', 'secretRefs', ['keyvault:abc'], 'snapshot_field_invalid'],
    ['pull request opened', 'pullRequest.open', true, 'pull_request_not_allowed'],
  ])('VT-08 / DoD-0: refuses a %s', (_label, path, value, code) => {
    const result = validateBuildLaunchSnapshot(withValue(path, value), ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const expectedPath = path === 'secretRefs' ? 'secretRefs[0]' : path;
    expect(result.refusals).toContainEqual({ code, fieldPath: expectedPath });
  });

  it('VT-08: refuses an unknown key, nested or top level', () => {
    const candidate = withValue('extra', 'x');
    (candidate.caps as Mutable).bonus = 1;

    const result = validateBuildLaunchSnapshot(candidate, ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals).toEqual(expect.arrayContaining([
      { code: 'snapshot_unknown_field', fieldPath: 'extra' },
      { code: 'snapshot_unknown_field', fieldPath: 'caps.bonus' },
    ]));
  });

  it('VT-08: refuses a target branch equal to the default branch', () => {
    expect(validateBuildLaunchSnapshot(withValue('targetBranch', 'main'), ctx)).toEqual({
      ok: false,
      refusals: [{ code: 'target_is_default_branch', fieldPath: 'targetBranch' }],
    });
  });

  it('VT-08: refuses a snapshot for another project', () => {
    expect(validateBuildLaunchSnapshot(completeSnapshot(), { ...ctx, expectedProjectId: 'Other' })).toEqual({
      ok: false,
      refusals: [{ code: 'project_mismatch', fieldPath: 'repository.project' }],
    });
  });

  it.each([
    ['a bearer token', 'prompt.key', 'Bearer abcdefghijklmnop1234'],
    ['a connection string', 'repository.repo', 'postgres://user:pw@host/db'],
    ['a secret key assignment', 'context[0].label', 'api_key=abc'],
    ['a held secret value', 'taskKey', `t1-${HELD}`],
  ])('VT-09 / DoD-1: refuses %s and never echoes it', (_label, path, planted) => {
    const result = validateBuildLaunchSnapshot(withValue(path, planted), ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals).toContainEqual({ code: 'snapshot_secret_value', fieldPath: path });
    expect(JSON.stringify(result.refusals)).not.toContain(planted);
  });

  it('VT-09 / DoD-1: refuses a secret in an unknown key name', () => {
    const candidate = withValue(`token=${HELD}`, 'x');

    const result = validateBuildLaunchSnapshot(candidate, ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusals.map((refusal) => refusal.code)).toContain('snapshot_secret_value');
    expect(JSON.stringify(result.refusals)).not.toContain(HELD);
  });

  it('VT-18: validates a 4 KB snapshot in under 50 ms', () => {
    const snapshot = completeSnapshot();
    snapshot.context = Array.from({ length: 24 }, (_, index) => ({
      container: 'cursor-prompts',
      key: `builds/run-1/context-${index}.md`,
      contentHash: HASH,
      label: `context note ${index}`,
    }));
    expect(JSON.stringify(snapshot).length).toBeGreaterThanOrEqual(4096);

    const started = performance.now();
    const result = validateBuildLaunchSnapshot(snapshot, ctx);
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('createSecretValueDetector', () => {
  it('finds held values exactly and ignores short ones', () => {
    const detector = createSecretValueDetector([HELD, 'short']);

    expect(detector.containsHeldSecretValue(`prefix ${HELD} suffix`)).toBe(true);
    expect(detector.containsHeldSecretValue('short')).toBe(false);
    expect(detector.containsHeldSecretValue('api_key=abc')).toBe(false);
    expect(detector.containsSecret('api_key=abc')).toBe(true);
  });
});
