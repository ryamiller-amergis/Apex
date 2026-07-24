import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { loadTestRuns, loadTests, loadTestTargets } from '../db/schema';
import type {
  CreateLoadTestDefinitionInput,
  CreateLoadTestRunInput,
  CreateLoadTestTargetInput,
  LoadTestDefinition,
  LoadTestRun,
  LoadTestTarget,
} from '../../shared/types/loadTest';
import { LoadTestValidationError } from '../../shared/types/loadTest';

// ── Row type aliases ───────────────────────────────────────────────────────────

type LoadTestRow = typeof loadTests.$inferSelect;
type LoadTestRunRow = typeof loadTestRuns.$inferSelect;
type LoadTestTargetRow = typeof loadTestTargets.$inferSelect;

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

function mapTargetRow(row: LoadTestTargetRow): LoadTestTarget {
  return {
    id: row.id,
    projectId: row.projectId,
    baseUrl: row.baseUrl,
    environmentLabel: row.environmentLabel,
    isReachable: row.isReachable,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

// ── Validation helpers ─────────────────────────────────────────────────────────

function assertProjectId(projectId: unknown): asserts projectId is string {
  if (!projectId || typeof projectId !== 'string') {
    throw new LoadTestValidationError('projectId is required', 'MISSING_PROJECT_ID');
  }
}

function assertDefinitionInput(input: CreateLoadTestDefinitionInput): void {
  if (!input.name?.trim()) {
    throw new LoadTestValidationError('name is required', 'MISSING_NAME');
  }
  if (!input.script?.trim()) {
    throw new LoadTestValidationError('script is required', 'MISSING_SCRIPT');
  }
  if (!input.targetUrl?.trim()) {
    throw new LoadTestValidationError('targetUrl is required', 'MISSING_TARGET_URL');
  }
  if (!input.environment?.trim()) {
    throw new LoadTestValidationError('environment is required', 'MISSING_ENVIRONMENT');
  }
  if (!input.loadProfile) {
    throw new LoadTestValidationError('loadProfile is required', 'MISSING_LOAD_PROFILE');
  }
}

// ── Definition CRUD ────────────────────────────────────────────────────────────

export async function createDefinition(
  projectId: string,
  input: CreateLoadTestDefinitionInput,
  userId: string,
): Promise<LoadTestDefinition> {
  assertProjectId(projectId);
  assertDefinitionInput(input);

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
        scriptSource: input.scriptSource ?? 'form_builder',
        script: input.script,
        loadProfile: input.loadProfile,
        clientThresholds: input.clientThresholds ?? [],
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

export async function deleteDefinition(projectId: string, id: string): Promise<boolean> {
  assertProjectId(projectId);

  const rows = await db
    .delete(loadTests)
    .where(and(eq(loadTests.id, id), eq(loadTests.projectId, projectId)))
    .returning({ id: loadTests.id });

  return rows.length > 0;
}

// ── Run CRUD ───────────────────────────────────────────────────────────────────

export async function createRun(
  projectId: string,
  input: CreateLoadTestRunInput,
): Promise<LoadTestRun> {
  assertProjectId(projectId);

  if (!input.loadTestId?.trim()) {
    throw new LoadTestValidationError('loadTestId is required', 'MISSING_LOAD_TEST_ID');
  }

  // Verify the definition belongs to this project before creating a run
  const definition = await getDefinition(projectId, input.loadTestId);
  if (!definition) {
    throw new LoadTestValidationError(
      'Load test definition not found in this project',
      'DEFINITION_NOT_FOUND',
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

// ── Target (Allowlist) CRUD ────────────────────────────────────────────────────

export async function createTarget(
  projectId: string,
  input: CreateLoadTestTargetInput,
  userId: string,
): Promise<LoadTestTarget> {
  assertProjectId(projectId);

  if (!input.baseUrl?.trim()) {
    throw new LoadTestValidationError('baseUrl is required', 'MISSING_BASE_URL');
  }
  if (!input.environmentLabel?.trim()) {
    throw new LoadTestValidationError('environmentLabel is required', 'MISSING_ENVIRONMENT_LABEL');
  }

  const rows = await db.transaction(async (tx) => {
    return tx
      .insert(loadTestTargets)
      .values({
        projectId,
        baseUrl: input.baseUrl,
        environmentLabel: input.environmentLabel,
        isReachable: input.isReachable ?? true,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
  });

  return mapTargetRow(rows[0]);
}

export async function listTargets(projectId: string): Promise<LoadTestTarget[]> {
  assertProjectId(projectId);

  const rows = await db
    .select()
    .from(loadTestTargets)
    .where(eq(loadTestTargets.projectId, projectId))
    .orderBy(desc(loadTestTargets.createdAt));

  return rows.map(mapTargetRow);
}

export async function deleteTarget(projectId: string, id: string): Promise<boolean> {
  assertProjectId(projectId);

  const rows = await db
    .delete(loadTestTargets)
    .where(and(eq(loadTestTargets.id, id), eq(loadTestTargets.projectId, projectId)))
    .returning({ id: loadTestTargets.id });

  return rows.length > 0;
}
