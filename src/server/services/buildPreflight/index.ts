/**
 * Preflight: given a project, a repository and the requester, return a frozen
 * run configuration or every refusal at once. The caller applies `builds:run`;
 * preflight checks run conditions only and writes nothing.
 */
import { BUILD_PROFILE_ROLES } from '../../../shared/types/build';
import {
  BUILD_REPAIR_ATTEMPTS,
  type FrozenBuildRunConfig,
  type PreflightResult,
} from '../../../shared/types/buildPreflight';
import { isFeatureEnabled } from '../featureFlagService';
import { isBuildPairAllowed } from '../buildAccessService';
import { loadSettingsForRepository, resolveBuildProfile } from '../buildProfileService';
import { getAssignmentsForProject } from '../userProjectAssignmentService';
import { redactText } from '../buildRedactionService';
import { trackEvent } from '../telemetry';
import {
  PREFLIGHT_CHECKS,
  SECRET_SCAN_ORDER,
  repoCoordsFor,
  type CheckContext,
  type Collected,
} from './checks';
import { deepFreeze } from './freeze';
import { buildRefusal, type RefusalSpec } from './messages';
import { RepoReadUnavailableError, type PreflightPorts } from './ports';
import {
  PREFLIGHT_READ_TIMEOUT_MS,
  listRepoFolder,
  readPipelineDefinition,
  readRepoFile,
} from './repoReader';

export { RepoReadUnavailableError } from './ports';
export type { AdoRepoCoords, PipelineDefinitionSummary, PreflightPorts } from './ports';

export const PREFLIGHT_BUDGET_MS = 10_000;

export interface PreflightInput {
  project: string;
  repository: string;
  userId: string;
}

export function createDefaultPreflightPorts(): PreflightPorts {
  return {
    loadSettings: loadSettingsForRepository,
    isPairAllowed: isBuildPairAllowed,
    isFlagEnabled: (flag, ctx) => isFeatureEnabled(flag, ctx),
    listAssignedUsers: async (project) => {
      const assignments = await getAssignmentsForProject(project);
      return new Map(assignments.map((a) => [a.userId, a.displayName || a.email || a.userId]));
    },
    readFile: readRepoFile,
    listFolder: listRepoFolder,
    readPipeline: readPipelineDefinition,
    redact: (text) => redactText(text),
    now: () => new Date(),
    log: (message) => console.warn(message),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RepoReadUnavailableError(new Error(`Read timed out after ${ms} ms`))), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Every async read gets its own timeout, so one slow read fails only its check. */
function timedPorts(ports: PreflightPorts): PreflightPorts {
  const t = PREFLIGHT_READ_TIMEOUT_MS;
  return {
    ...ports,
    loadSettings: (...args) => withTimeout(ports.loadSettings(...args), t),
    isPairAllowed: (...args) => withTimeout(ports.isPairAllowed(...args), t),
    isFlagEnabled: (...args) => withTimeout(ports.isFlagEnabled(...args), t),
    listAssignedUsers: (...args) => withTimeout(ports.listAssignedUsers(...args), t),
    readFile: (...args) => withTimeout(ports.readFile(...args), t),
    listFolder: (...args) => withTimeout(ports.listFolder(...args), t),
    readPipeline: (...args) => withTimeout(ports.readPipeline(...args), t),
  };
}

function errorText(err: unknown): string {
  const inner = err instanceof RepoReadUnavailableError ? err.cause : err;
  return inner instanceof Error ? inner.message : String(inner);
}

/** Every string leaf with its dotted path, skipping content digests. */
function stringLeaves(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') {
    out.push([path, value]);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/sha256$/i.test(key)) continue;
    stringLeaves(child, path ? `${path}.${key}` : key, out);
  }
}

function secretFields(config: FrozenBuildRunConfig, redact: (text: string) => string): string[] {
  const leaves: Array<[string, string]> = [];
  stringLeaves(config, '', leaves);
  return leaves.filter(([, text]) => redact(text) !== text).map(([path]) => path);
}

function assemble(input: PreflightInput, ctx: CheckContext, resolvedAt: Date): FrozenBuildRunConfig {
  const c: Collected = ctx.collected;
  const resolution = ctx.resolution;
  if (
    !resolution || !ctx.coords || resolution.caps.costUsd === null || !c.supportContacts || !c.designSystem ||
    !c.codingRules || !c.codeMap || !c.agentEnvironment || c.pipelineId === undefined || !c.qualityManifest
  ) {
    throw new Error('Preflight invariant: a passing run is missing collected configuration');
  }
  const roles = {} as FrozenBuildRunConfig['roles'];
  for (const role of BUILD_PROFILE_ROLES) {
    const r = resolution.roles[role];
    const skill = c.roleSkills[role];
    if (!r.skillPath || !r.model || !r.modelSource || !skill) {
      throw new Error(`Preflight invariant: role ${role} passed without a resolved skill and model`);
    }
    roles[role] = { skillPath: r.skillPath, skillSha256: skill.sha256, model: r.model, modelSource: r.modelSource };
  }
  return {
    schemaVersion: 1,
    project: input.project,
    repository: { provider: 'ado', ...ctx.coords },
    resolvedAt: resolvedAt.toISOString(),
    roles,
    caps: {
      costUsd: resolution.caps.costUsd,
      elapsedMinutesPerRevision: resolution.caps.elapsedMinutesPerRevision,
      maxRevisions: resolution.caps.maxRevisions,
      maxParallelism: resolution.caps.maxParallelism,
      repairAttempts: BUILD_REPAIR_ATTEMPTS,
    },
    supportContacts: c.supportContacts,
    standards: { designSystem: c.designSystem, codingRules: c.codingRules, codeMap: c.codeMap },
    qualityManifest: c.qualityManifest,
    agentEnvironment: c.agentEnvironment,
    pipeline: { definitionId: c.pipelineId },
  };
}

export async function runPreflight(
  input: PreflightInput,
  rawPorts: PreflightPorts = createDefaultPreflightPorts(),
): Promise<PreflightResult> {
  const startedAt = Date.now();
  const ports = timedPorts(rawPorts);
  const log = (item: string, err: unknown) =>
    rawPorts.log(`[buildPreflight] ${item} unavailable: ${rawPorts.redact(errorText(err))}`);

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    budgetTimer = setTimeout(() => reject(new RepoReadUnavailableError(new Error('Preflight budget exceeded'))), PREFLIGHT_BUDGET_MS);
  });
  budget.catch(() => undefined);

  try {
    const ordered: Array<{ order: number; specs: RefusalSpec[] }> = [];
    let row: CheckContext['row'] = null;
    try {
      row = await Promise.race([ports.loadSettings(input.project, input.repository), budget]);
    } catch (err) {
      log('repository configuration', err);
      ordered.push({ order: 1, specs: [{ code: 'check_unavailable', item: 'repository configuration' }] });
    }
    const rowUnavailable = ordered.length > 0;

    const ctx: CheckContext = {
      project: input.project,
      repository: input.repository,
      userId: input.userId,
      row,
      coords: row && (row.skillProvider ?? 'ado') === 'ado' ? repoCoordsFor(row, input.project) : null,
      resolution: row ? resolveBuildProfile(row) : null,
      ports,
      collected: { roleSkills: {} },
    };

    const checks = rowUnavailable ? PREFLIGHT_CHECKS.filter((c) => c.order !== 1) : PREFLIGHT_CHECKS;
    const results = await Promise.all(
      checks.map(async (check) => {
        try {
          return { order: check.order, specs: await Promise.race([check.run(ctx), budget]) };
        } catch (err) {
          log(check.item, err);
          return { order: check.order, specs: [{ code: 'check_unavailable', item: check.item } as RefusalSpec] };
        }
      }),
    );
    ordered.push(...results);
    ordered.sort((a, b) => a.order - b.order);

    let specs = ordered.flatMap((entry) => entry.specs);
    let config: FrozenBuildRunConfig | null = null;
    if (specs.length === 0) {
      config = assemble(input, ctx, rawPorts.now());
      const fields = secretFields(config, rawPorts.redact);
      specs = fields.map((field): RefusalSpec => ({ code: 'secret_in_snapshot', field }));
      if (specs.length > 0) {
        ordered.push({ order: SECRET_SCAN_ORDER, specs });
        config = null;
      }
    }

    const refusalCtx = {
      project: input.project,
      supportContactNames: (ctx.collected.supportContacts ?? []).map((c) => c.displayName),
    };
    const result: PreflightResult = config
      ? { ok: true, config: deepFreeze(config) }
      : { ok: false, refusals: specs.map((spec) => buildRefusal(spec, refusalCtx)) };

    trackEvent(
      'BuildPreflightCompleted',
      {
        project: input.project,
        repository: input.repository,
        ok: String(result.ok),
        refusalCodes: result.ok ? '' : result.refusals.map((r) => r.code).join(','),
      },
      { durationMs: Date.now() - startedAt },
    );
    return result;
  } finally {
    clearTimeout(budgetTimer);
  }
}
