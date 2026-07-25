import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { loadTestRuns, loadTests } from '../db/schema';
import type {
  CreateLoadTestDefinitionInput,
  CreateLoadTestRunInput,
  LoadProfile,
  LoadTestDefinition,
  LoadTestPortableDefinition,
  LoadTestRun,
  RunStatus,
  Threshold,
  UpdateLoadTestDefinitionInput,
} from '../../shared/types/loadTest';
import { LoadTestValidationError } from '../../shared/types/loadTest';
import {
  assertTargetAllowlisted,
  isProdEnvironmentLabel,
  isProdHostname,
  normalizeTargetUrl,
} from './loadTestTargetService';

// ── Row type aliases ───────────────────────────────────────────────────────────

type LoadTestRow = typeof loadTests.$inferSelect;
type LoadTestRunRow = typeof loadTestRuns.$inferSelect;

// ── Constants — profile caps (platform defaults, A-005) ───────────────────────

export const LOAD_TEST_CAPS = {
  maxVus: 5_000,
  maxDurationMinutes: 60,
  maxRpsCap: 10_000,
} as const;

// ── Prod-pattern detection (BR-001) — delegates to FEAT-005 helpers ───────────

export function isProdTarget(target: string, environment: string): boolean {
  if (isProdEnvironmentLabel(environment)) return true;
  try {
    const normalized = normalizeTargetUrl(target);
    return isProdHostname(new URL(normalized).hostname);
  } catch {
    // Fallback for non-URL strings used in unit tests / legacy callers
    return isProdHostname(target) || /(?:^|[.-/\s])prod(?:[.-/\s]|$)/i.test(target);
  }
}

// ── Plaintext secret detection (BR-006) ───────────────────────────────────────

const PLAINTEXT_SECRET_PATTERNS = [
  /bearer\s+[a-zA-Z0-9\-._~+/]+=*/i,
  /^[Aa]uthorization:\s*\S/m,
  /api[_-]?key\s*[:=]\s*\S/i,
  /password\s*[:=]\s*\S/i,
  /secret\s*[:=]\s*(?!kv:|vault:)\S/i,
];

export function containsPlaintextSecret(value: string): boolean {
  return PLAINTEXT_SECRET_PATTERNS.some((p) => p.test(value));
}

function checkSecretRefs(secretRefs: Record<string, string> | null | undefined): void {
  if (!secretRefs) return;
  for (const [key, value] of Object.entries(secretRefs)) {
    if (containsPlaintextSecret(value)) {
      throw new LoadTestValidationError(
        `Secret ref "${key}" appears to contain a plaintext credential. Use a Key Vault reference instead (e.g. kv://<vault>/<secret>).`,
        'LOAD_TEST_PLAINTEXT_SECRET',
      );
    }
    // A Key Vault ref must begin with "kv:" or "vault:" prefix, or be a URI-style ref
    // Accept any opaque reference if it doesn't match plaintext patterns above
  }
}

function checkScriptForSecrets(script: string): void {
  if (containsPlaintextSecret(script)) {
    throw new LoadTestValidationError(
      'Script appears to contain a plaintext credential. Store credentials as Key Vault secret references and inject at runtime.',
      'LOAD_TEST_PLAINTEXT_SECRET',
    );
  }
}

// ── Profile cap enforcement (BR-004) ─────────────────────────────────────────

export function enforceProfileCaps(profile: LoadProfile): void {
  if (profile.vus > LOAD_TEST_CAPS.maxVus) {
    throw new LoadTestValidationError(
      `VU count ${profile.vus} exceeds platform cap of ${LOAD_TEST_CAPS.maxVus}.`,
      'LOAD_TEST_PROFILE_CAP_EXCEEDED',
    );
  }
  if (profile.durationMinutes > LOAD_TEST_CAPS.maxDurationMinutes) {
    throw new LoadTestValidationError(
      `Duration ${profile.durationMinutes} minutes exceeds platform cap of ${LOAD_TEST_CAPS.maxDurationMinutes} minutes.`,
      'LOAD_TEST_PROFILE_CAP_EXCEEDED',
    );
  }
  if (profile.rpsCap !== undefined && profile.rpsCap > LOAD_TEST_CAPS.maxRpsCap) {
    throw new LoadTestValidationError(
      `RPS cap ${profile.rpsCap} exceeds platform cap of ${LOAD_TEST_CAPS.maxRpsCap}.`,
      'LOAD_TEST_PROFILE_CAP_EXCEEDED',
    );
  }
}

// ── Allowlist validation (BR-001, BR-002) — FEAT-005 helpers ───────────────────

export async function assertAllowlistedNonProd(
  projectId: string,
  targetUrl: string,
  environment: string,
): Promise<void> {
  // Hard-refuse prod-tagged environments first (BR-001)
  if (isProdEnvironmentLabel(environment)) {
    throw new LoadTestValidationError(
      `Target "${targetUrl}" (environment "${environment}") appears to be a production environment and is refused.`,
      'LOAD_TEST_PROD_TARGET_REFUSED',
    );
  }

  // Active allowlist match + hostname prod refuse (BR-001 / BR-002)
  await assertTargetAllowlisted(projectId, targetUrl);
}

// ── Raw-script threshold reconciliation (PBI-004 AC-2, A-007) ─────────────────
// Best-effort parse of k6 options.thresholds from the script text.
// Returns { thresholds, reconciled } where reconciled=false means parse failed.

interface ReconcileResult {
  thresholds: Threshold[];
  reconciled: boolean;
}

export function reconcileThresholds(
  script: string,
  clientThresholds: Threshold[],
): ReconcileResult {
  try {
    // Extract the options object literal (best-effort, covers most idiomatic k6 scripts)
    const optionsMatch = script.match(/export\s+(?:const|let|var)\s+options\s*=\s*(\{[\s\S]*?\});/);
    if (!optionsMatch) {
      return { thresholds: clientThresholds, reconciled: false };
    }

    const optionsBody = optionsMatch[1];

    // Extract thresholds block
    const thresholdsMatch = optionsBody.match(/['"]?thresholds['"]?\s*:\s*(\{[\s\S]*?\})/);
    if (!thresholdsMatch) {
      return { thresholds: clientThresholds, reconciled: false };
    }

    const thresholdsBody = thresholdsMatch[1];

    // Parse metric → expression array entries
    const parsed: Threshold[] = [];
    const entryRegex = /['"]?(\w+)['"]?\s*:\s*\[([^\]]*)\]/g;
    let match: RegExpExecArray | null;

    while ((match = entryRegex.exec(thresholdsBody)) !== null) {
      const metric = match[1];
      const expressionsRaw = match[2];
      const exprRegex = /['"]([^'"]+)['"]/g;
      let exprMatch: RegExpExecArray | null;
      while ((exprMatch = exprRegex.exec(expressionsRaw)) !== null) {
        parsed.push({ metric, expression: exprMatch[1] });
      }
    }

    if (parsed.length === 0) {
      return { thresholds: clientThresholds, reconciled: false };
    }

    return { thresholds: parsed, reconciled: true };
  } catch {
    return { thresholds: clientThresholds, reconciled: false };
  }
}

// ── Row → Domain mappers ───────────────────────────────────────────────────────

function mapDefinitionRow(row: LoadTestRow): LoadTestDefinition {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description ?? null,
    requirementRef: row.requirementRef ?? null,
    targetUrl: row.targetUrl,
    environment: row.environment,
    engine: row.engine,
    flowType: row.flowType,
    scriptSource: row.scriptSource,
    script: row.script,
    loadProfile: row.loadProfile,
    clientThresholds: row.clientThresholds,
    runSource: row.runSource ?? null,
    secretRefs: row.secretRefs ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

function mapRunRow(row: LoadTestRunRow): LoadTestRun {
  return {
    id: row.id,
    projectId: row.projectId,
    loadTestId: row.loadTestId,
    status: row.status,
    runSource: row.runSource,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    heartbeatAt: row.heartbeatAt ?? null,
    dispatchMessageId: row.dispatchMessageId ?? null,
    cancelRequested: row.cancelRequested,
    overallResult: row.overallResult ?? null,
    thresholdResults: row.thresholdResults ?? null,
    summaryArtifactRef: row.summaryArtifactRef ?? null,
    timeseriesArtifactRef: row.timeseriesArtifactRef ?? null,
    errorDetail: row.errorDetail ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Validation helpers ─────────────────────────────────────────────────────────

function assertProjectId(projectId: unknown): asserts projectId is string {
  if (!projectId || typeof projectId !== 'string') {
    throw new LoadTestValidationError('projectId is required', 'LOAD_TEST_VALIDATION');
  }
}

function assertDefinitionInput(input: CreateLoadTestDefinitionInput): void {
  if (!input.name?.trim()) {
    throw new LoadTestValidationError('name is required', 'LOAD_TEST_VALIDATION');
  }
  if (!input.script?.trim()) {
    throw new LoadTestValidationError('script is required', 'LOAD_TEST_VALIDATION');
  }
  if (!input.targetUrl?.trim()) {
    throw new LoadTestValidationError('targetUrl is required', 'LOAD_TEST_VALIDATION');
  }
  if (!input.environment?.trim()) {
    throw new LoadTestValidationError('environment is required', 'LOAD_TEST_VALIDATION');
  }
  if (!input.loadProfile) {
    throw new LoadTestValidationError('loadProfile is required', 'LOAD_TEST_VALIDATION');
  }
  if (typeof input.loadProfile.vus !== 'number') {
    throw new LoadTestValidationError('loadProfile.vus is required', 'LOAD_TEST_VALIDATION');
  }
  if (typeof input.loadProfile.durationMinutes !== 'number') {
    throw new LoadTestValidationError('loadProfile.durationMinutes is required', 'LOAD_TEST_VALIDATION');
  }
  if (!Array.isArray(input.clientThresholds)) {
    throw new LoadTestValidationError('clientThresholds must be an array', 'LOAD_TEST_VALIDATION');
  }
}

// ── Full validation pipeline for writes ───────────────────────────────────────
// Order per tech-spec §4: schema → allowlist/non-prod → caps → secret-ref scan
// → raw reconciliation → persist

async function runWriteValidation(
  projectId: string,
  targetUrl: string,
  environment: string,
  loadProfile: LoadProfile,
  script: string,
  secretRefs: Record<string, string> | null | undefined,
  scriptSource: string,
): Promise<{ reconciledThresholds?: Threshold[]; thresholdsReconciled?: boolean }> {
  // 1. Allowlist + non-prod check
  await assertAllowlistedNonProd(projectId, targetUrl, environment);

  // 2. Profile cap enforcement
  enforceProfileCaps(loadProfile);

  // 3. Secret-ref scan — check secretRefs object and script body
  checkSecretRefs(secretRefs);
  checkScriptForSecrets(script);

  // 4. Raw reconciliation (best-effort, non-blocking)
  if (scriptSource === 'raw') {
    return { thresholdsReconciled: true };
  }
  return {};
}

// ── Definition CRUD ────────────────────────────────────────────────────────────

export async function createDefinition(
  projectId: string,
  input: CreateLoadTestDefinitionInput,
  userId: string,
): Promise<LoadTestDefinition> {
  assertProjectId(projectId);
  assertDefinitionInput(input);

  const scriptSource = input.scriptSource ?? 'form_builder';

  await runWriteValidation(
    projectId,
    input.targetUrl,
    input.environment,
    input.loadProfile,
    input.script,
    input.secretRefs,
    scriptSource,
  );

  let resolvedThresholds = input.clientThresholds ?? [];
  if (scriptSource === 'raw') {
    const { thresholds } = reconcileThresholds(input.script, resolvedThresholds);
    resolvedThresholds = thresholds;
  }

  const rows = await db.transaction(async (tx) => {
    return tx
      .insert(loadTests)
      .values({
        projectId,
        name: input.name,
        description: input.description ?? null,
        requirementRef: input.requirementRef ?? null,
        targetUrl: input.targetUrl,
        environment: input.environment,
        engine: input.engine ?? 'k6',
        flowType: input.flowType ?? 'single',
        scriptSource,
        script: input.script,
        loadProfile: input.loadProfile,
        clientThresholds: resolvedThresholds,
        runSource: input.runSource ?? null,
        secretRefs: input.secretRefs ?? null,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
  });

  return mapDefinitionRow(rows[0]);
}

export async function getDefinition(
  projectId: string,
  id: string,
): Promise<LoadTestDefinition | null> {
  assertProjectId(projectId);

  const rows = await db
    .select()
    .from(loadTests)
    .where(and(eq(loadTests.id, id), eq(loadTests.projectId, projectId)))
    .limit(1);

  return rows.length > 0 ? mapDefinitionRow(rows[0]) : null;
}

export async function listDefinitions(projectId: string): Promise<LoadTestDefinition[]> {
  assertProjectId(projectId);

  const rows = await db
    .select()
    .from(loadTests)
    .where(eq(loadTests.projectId, projectId))
    .orderBy(desc(loadTests.createdAt));

  return rows.map(mapDefinitionRow);
}

export async function updateDefinition(
  projectId: string,
  id: string,
  input: UpdateLoadTestDefinitionInput,
  userId: string,
): Promise<LoadTestDefinition> {
  assertProjectId(projectId);

  const existing = await getDefinition(projectId, id);
  if (!existing) {
    throw new LoadTestValidationError(
      'Load test definition not found',
      'LOAD_TEST_NOT_FOUND',
    );
  }

  // Merge with existing values so guardrails always see the full post-merge state
  const targetUrl = input.targetUrl ?? existing.targetUrl;
  const environment = input.environment ?? existing.environment;
  const loadProfile = input.loadProfile ?? existing.loadProfile;
  const script = input.script ?? existing.script;
  const scriptSource = input.scriptSource ?? existing.scriptSource;
  const secretRefs = 'secretRefs' in input ? input.secretRefs : existing.secretRefs;

  await runWriteValidation(projectId, targetUrl, environment, loadProfile, script, secretRefs, scriptSource);

  let resolvedThresholds = input.clientThresholds ?? existing.clientThresholds;
  if (scriptSource === 'raw' && input.script) {
    const { thresholds } = reconcileThresholds(input.script, resolvedThresholds);
    resolvedThresholds = thresholds;
  }

  const updateValues: Partial<typeof loadTests.$inferInsert> = {
    updatedBy: userId,
    updatedAt: new Date().toISOString(),
    clientThresholds: resolvedThresholds,
  };

  if (input.name !== undefined) updateValues.name = input.name;
  if (input.description !== undefined) updateValues.description = input.description ?? null;
  if ('requirementRef' in input) updateValues.requirementRef = input.requirementRef ?? null;
  if (input.targetUrl !== undefined) updateValues.targetUrl = input.targetUrl;
  if (input.environment !== undefined) updateValues.environment = input.environment;
  if (input.engine !== undefined) updateValues.engine = input.engine;
  if (input.flowType !== undefined) updateValues.flowType = input.flowType;
  if (input.scriptSource !== undefined) updateValues.scriptSource = input.scriptSource;
  if (input.script !== undefined) updateValues.script = input.script;
  if (input.loadProfile !== undefined) updateValues.loadProfile = input.loadProfile;
  if ('runSource' in input) updateValues.runSource = input.runSource ?? null;
  if ('secretRefs' in input) updateValues.secretRefs = input.secretRefs ?? null;

  const rows = await db.transaction(async (tx) => {
    return tx
      .update(loadTests)
      .set(updateValues)
      .where(and(eq(loadTests.id, id), eq(loadTests.projectId, projectId)))
      .returning();
  });

  return mapDefinitionRow(rows[0]);
}

/** Hard delete — rejects with 409 if an active run exists (A-009). */
export async function deleteDefinition(projectId: string, id: string): Promise<boolean> {
  assertProjectId(projectId);

  // Check for active runs (queued | dispatched | running) before deleting (A-009)
  const activeStatuses: RunStatus[] = ['queued', 'dispatched', 'running'];
  const activeRuns = await db
    .select({ id: loadTestRuns.id })
    .from(loadTestRuns)
    .where(
      and(
        eq(loadTestRuns.loadTestId, id),
        eq(loadTestRuns.projectId, projectId),
        inArray(loadTestRuns.status, activeStatuses),
      ),
    )
    .limit(1);

  if (activeRuns.length > 0) {
    throw new LoadTestValidationError(
      'Cannot delete definition while an active run exists. Wait for the run to complete or cancel it first.',
      'LOAD_TEST_ACTIVE_RUN',
    );
  }

  const rows = await db
    .delete(loadTests)
    .where(and(eq(loadTests.id, id), eq(loadTests.projectId, projectId)))
    .returning({ id: loadTests.id });

  return rows.length > 0;
}

/** Returns a secret-free portable artifact (PBI-005, A-010). */
export async function getPortable(
  projectId: string,
  id: string,
): Promise<LoadTestPortableDefinition | null> {
  assertProjectId(projectId);

  const rows = await db
    .select()
    .from(loadTests)
    .where(and(eq(loadTests.id, id), eq(loadTests.projectId, projectId)))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];

  // Explicitly omit secretRefs and any internal fields — secret-free (BR-006, PBI-005 AC-1)
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    flowType: row.flowType,
    script: row.script,
    loadProfile: row.loadProfile,
    clientThresholds: row.clientThresholds,
  };
}

// ── Run CRUD ───────────────────────────────────────────────────────────────────

export async function createRun(
  projectId: string,
  input: CreateLoadTestRunInput,
): Promise<LoadTestRun> {
  assertProjectId(projectId);

  if (!input.loadTestId?.trim()) {
    throw new LoadTestValidationError('loadTestId is required', 'LOAD_TEST_VALIDATION');
  }

  const definition = await getDefinition(projectId, input.loadTestId);
  if (!definition) {
    throw new LoadTestValidationError(
      'Load test definition not found in this project',
      'LOAD_TEST_NOT_FOUND',
    );
  }

  const rows = await db.transaction(async (tx) => {
    return tx
      .insert(loadTestRuns)
      .values({
        projectId,
        loadTestId: input.loadTestId,
        runSource: input.runSource,
        dispatchMessageId: input.dispatchMessageId ?? null,
        status: 'queued',
      })
      .returning();
  });

  return mapRunRow(rows[0]);
}

export async function getRun(projectId: string, id: string): Promise<LoadTestRun | null> {
  assertProjectId(projectId);

  const rows = await db
    .select()
    .from(loadTestRuns)
    .where(and(eq(loadTestRuns.id, id), eq(loadTestRuns.projectId, projectId)))
    .limit(1);

  return rows.length > 0 ? mapRunRow(rows[0]) : null;
}

export async function listRuns(
  projectId: string,
  loadTestId?: string,
): Promise<LoadTestRun[]> {
  assertProjectId(projectId);

  const conditions = loadTestId
    ? and(eq(loadTestRuns.projectId, projectId), eq(loadTestRuns.loadTestId, loadTestId))
    : eq(loadTestRuns.projectId, projectId);

  const rows = await db
    .select()
    .from(loadTestRuns)
    .where(conditions)
    .orderBy(desc(loadTestRuns.createdAt));

  return rows.map(mapRunRow);
}

// Target allowlist CRUD lives in loadTestTargetService (FEAT-005).
