import { BuildQueryOrder, BuildStatus } from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { and, asc, gte, inArray, lte } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { e2eBurnDownSnapshots } from '../db/schema';
import type {
  E2eBuildSnapshot,
  E2eBurnDownResponse,
  E2eSuiteDefinition,
  E2eSuiteKey,
} from '../types/workitem';
import {
  downloadArtifactZip,
  getAdoConnection,
  mapWithConcurrency,
  normalizePagedList,
} from '../utils/adoArtifactZip';
import { parsePlaywrightStatsFromArtifactZip } from '../utils/playwrightReportParser';

/** MaxView nightly pipeline contract — same pipeline as ESLint burn-down. */
const E2E_BUILD_PROJECT = 'MaxView';
const E2E_BUILD_DEFINITION = 'mv-nightly-runs-workflow';
const BUILD_FETCH_TOP = 200;
const ARTIFACT_CONCURRENCY = 4;

/** Artifact names observed on the mv-nightly-runs-workflow E2E stages. */
export const E2E_SUITE_DEFINITIONS: E2eSuiteDefinition[] = [
  { key: 'quick_smoke', artifactName: 'PlaywrightReport_quick_smoke', label: 'Quick Smoke' },
  { key: 'timecard_validation', artifactName: 'PlaywrightReport_timecard_validation', label: 'Timecard Validation' },
  { key: 'long_workflow', artifactName: 'PlaywrightReport_long_workflow', label: 'Long Workflow' },
  { key: 'long_running', artifactName: 'PlaywrightReport_long_running', label: 'Long Running' },
];

const E2E_SUITE_BY_ARTIFACT = new Map(E2E_SUITE_DEFINITIONS.map(suite => [suite.artifactName, suite]));
const E2E_SUITE_BY_KEY = new Map(E2E_SUITE_DEFINITIONS.map(suite => [suite.key, suite]));

function computePassRate(passed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((passed / total) * 10000) / 100;
}

function rowToSnapshot(row: typeof e2eBurnDownSnapshots.$inferSelect): E2eBuildSnapshot {
  const suite = E2E_SUITE_BY_KEY.get(row.suiteKey as E2eSuiteKey);
  return {
    capturedAt: row.capturedAt,
    buildId: String(row.pipelineBuildId),
    buildNumber: row.buildNumber,
    definitionName: row.definitionName,
    suiteKey: row.suiteKey as E2eSuiteKey,
    suiteLabel: suite?.label ?? row.suiteKey,
    totalTests: row.totalTests,
    passed: row.passed,
    failed: row.failed,
    flaky: row.flaky,
    skipped: row.skipped,
    passRate: Number(row.passRate),
  };
}

function parsePipelineBuildId(buildId: string): number | null {
  const parsed = Number.parseInt(buildId, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

async function resolveBuildDefinition(
  buildApi: Awaited<ReturnType<ReturnType<typeof getAdoConnection>['getBuildApi']>>,
  project: string,
  definitionName: string,
): Promise<{ id: number; name: string }> {
  const definitions = normalizePagedList<{ id?: number; name?: string }>(
    await buildApi.getDefinitions(project, definitionName),
  );
  const exact = definitions.find(item => item.name === definitionName);
  if (exact?.id) {
    return { id: exact.id, name: exact.name ?? definitionName };
  }

  const fuzzy = definitions.find(item => item.name?.toLowerCase().includes(definitionName.toLowerCase()));
  if (fuzzy?.id) {
    return { id: fuzzy.id, name: fuzzy.name ?? definitionName };
  }

  throw new Error(
    `Build definition "${definitionName}" was not found in project "${project}".`,
  );
}

async function getStoredBuildIds(buildIds: number[]): Promise<Set<number>> {
  if (buildIds.length === 0) return new Set();
  const rows = await db
    .select({ pipelineBuildId: e2eBurnDownSnapshots.pipelineBuildId })
    .from(e2eBurnDownSnapshots)
    .where(inArray(e2eBurnDownSnapshots.pipelineBuildId, buildIds));
  return new Set(rows.map(row => row.pipelineBuildId));
}

async function getSnapshotsInRange(from: string, to: string): Promise<E2eBuildSnapshot[]> {
  const minTime = `${from}T00:00:00.000Z`;
  const maxTime = `${to}T23:59:59.999Z`;
  const rows = await db
    .select()
    .from(e2eBurnDownSnapshots)
    .where(and(gte(e2eBurnDownSnapshots.capturedAt, minTime), lte(e2eBurnDownSnapshots.capturedAt, maxTime)))
    .orderBy(asc(e2eBurnDownSnapshots.capturedAt));
  return rows.map(rowToSnapshot);
}

async function upsertSnapshot(snapshot: E2eBuildSnapshot): Promise<void> {
  const pipelineBuildId = parsePipelineBuildId(snapshot.buildId);
  if (pipelineBuildId === null) return;

  const syncedAt = new Date().toISOString();
  await db
    .insert(e2eBurnDownSnapshots)
    .values({
      pipelineBuildId,
      suiteKey: snapshot.suiteKey,
      buildNumber: snapshot.buildNumber,
      definitionName: snapshot.definitionName,
      capturedAt: snapshot.capturedAt,
      totalTests: snapshot.totalTests,
      passed: snapshot.passed,
      failed: snapshot.failed,
      flaky: snapshot.flaky,
      skipped: snapshot.skipped,
      passRate: String(snapshot.passRate),
      syncedAt,
    })
    .onConflictDoUpdate({
      target: [e2eBurnDownSnapshots.pipelineBuildId, e2eBurnDownSnapshots.suiteKey],
      set: {
        buildNumber: snapshot.buildNumber,
        definitionName: snapshot.definitionName,
        capturedAt: snapshot.capturedAt,
        totalTests: snapshot.totalTests,
        passed: snapshot.passed,
        failed: snapshot.failed,
        flaky: snapshot.flaky,
        skipped: snapshot.skipped,
        passRate: String(snapshot.passRate),
        syncedAt,
      },
    });
}

async function fetchSuiteSnapshotFromBuild(
  buildApi: Awaited<ReturnType<ReturnType<typeof getAdoConnection>['getBuildApi']>>,
  build: { id?: number; buildNumber?: string; finishTime?: Date },
  suite: E2eSuiteDefinition,
  definitionName: string,
): Promise<E2eBuildSnapshot | null> {
  if (!build.id) return null;

  try {
    const zipBuffer = await downloadArtifactZip(buildApi, E2E_BUILD_PROJECT, build.id, suite.artifactName);
    if (!zipBuffer) return null;

    const stats = await parsePlaywrightStatsFromArtifactZip(zipBuffer);
    if (!stats) return null;

    const capturedAt = build.finishTime?.toISOString() ?? new Date().toISOString();
    return {
      capturedAt,
      buildId: String(build.id),
      buildNumber: String(build.buildNumber ?? build.id),
      definitionName,
      suiteKey: suite.key,
      suiteLabel: suite.label,
      totalTests: stats.total,
      passed: stats.passed,
      failed: stats.failed,
      flaky: stats.flaky,
      skipped: stats.skipped,
      passRate: computePassRate(stats.passed, stats.total),
    };
  } catch {
    return null;
  }
}

async function fetchSnapshotsFromBuild(
  buildApi: Awaited<ReturnType<ReturnType<typeof getAdoConnection>['getBuildApi']>>,
  build: { id?: number; buildNumber?: string; finishTime?: Date },
  definitionName: string,
): Promise<E2eBuildSnapshot[]> {
  const results = await mapWithConcurrency(E2E_SUITE_DEFINITIONS, ARTIFACT_CONCURRENCY, suite =>
    fetchSuiteSnapshotFromBuild(buildApi, build, suite, definitionName),
  );
  return results.filter((snapshot): snapshot is E2eBuildSnapshot => snapshot !== null);
}

async function syncMissingSnapshots(
  buildApi: Awaited<ReturnType<ReturnType<typeof getAdoConnection>['getBuildApi']>>,
  builds: Array<{ id?: number; buildNumber?: string; finishTime?: Date }>,
  storedBuildIds: Set<number>,
  definitionName: string,
): Promise<number> {
  const missingBuilds = builds.filter(build => build.id && !storedBuildIds.has(build.id));
  if (missingBuilds.length === 0) return 0;

  let syncedCount = 0;
  for (const build of missingBuilds) {
    const snapshots = await fetchSnapshotsFromBuild(buildApi, build, definitionName);
    for (const snapshot of snapshots) {
      await upsertSnapshot(snapshot);
      syncedCount += 1;
    }
  }
  return syncedCount;
}

function buildLatestBySuite(snapshots: E2eBuildSnapshot[]): Partial<Record<E2eSuiteKey, E2eBuildSnapshot>> {
  const latest: Partial<Record<E2eSuiteKey, E2eBuildSnapshot>> = {};
  for (const snapshot of snapshots) {
    const existing = latest[snapshot.suiteKey];
    if (!existing || snapshot.capturedAt.localeCompare(existing.capturedAt) >= 0) {
      latest[snapshot.suiteKey] = snapshot;
    }
  }
  return latest;
}

/** Resolve suite key from a PlaywrightReport_* artifact name (for discovery). */
export function suiteKeyFromArtifactName(artifactName: string): E2eSuiteKey | null {
  const known = E2E_SUITE_BY_ARTIFACT.get(artifactName);
  if (known) return known.key;

  const match = /^PlaywrightReport_(.+)$/i.exec(artifactName.trim());
  if (!match?.[1]) return null;

  const candidate = match[1].toLowerCase().replace(/-/g, '_') as E2eSuiteKey;
  return E2E_SUITE_BY_KEY.has(candidate) ? candidate : null;
}

export async function syncRecentE2eBurnDownSnapshots(
  lookbackDays = 7,
): Promise<{ scanned: number; synced: number }> {
  const maxTime = new Date();
  const minTime = new Date(maxTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const connection = getAdoConnection();
  const buildApi = await connection.getBuildApi();
  const definition = await resolveBuildDefinition(buildApi, E2E_BUILD_PROJECT, E2E_BUILD_DEFINITION);

  const buildsPage = await buildApi.getBuilds(
    E2E_BUILD_PROJECT,
    [definition.id],
    undefined,
    undefined,
    minTime,
    maxTime,
    undefined,
    undefined,
    BuildStatus.Completed,
    undefined,
    undefined,
    undefined,
    BUILD_FETCH_TOP,
    undefined,
    undefined,
    undefined,
    BuildQueryOrder.FinishTimeAscending,
  );

  const builds = normalizePagedList<{ id?: number; buildNumber?: string; finishTime?: Date }>(buildsPage);
  const buildIds = builds.map(build => build.id).filter((id): id is number => typeof id === 'number');
  const storedBuildIds = await getStoredBuildIds(buildIds);
  const synced = await syncMissingSnapshots(buildApi, builds, storedBuildIds, definition.name);

  return { scanned: builds.length, synced };
}

export async function getMaxViewE2eBurnDown(from: string, to: string): Promise<E2eBurnDownResponse> {
  const minTime = new Date(`${from}T00:00:00.000Z`);
  const maxTime = new Date(`${to}T23:59:59.999Z`);

  if (Number.isNaN(minTime.getTime()) || Number.isNaN(maxTime.getTime())) {
    throw new Error('Invalid from/to date range for E2E burn-down');
  }
  if (minTime > maxTime) {
    throw new Error('The from date must be before the to date');
  }

  let snapshots = await getSnapshotsInRange(from, to);
  let definitionName = E2E_BUILD_DEFINITION;
  let definitionId: number | undefined;
  let buildsScanned = 0;
  let hint: string | undefined;
  let buildsSynced = 0;

  try {
    const connection = getAdoConnection();
    const buildApi = await connection.getBuildApi();
    const definition = await resolveBuildDefinition(buildApi, E2E_BUILD_PROJECT, E2E_BUILD_DEFINITION);
    definitionName = definition.name;
    definitionId = definition.id;

    const buildsPage = await buildApi.getBuilds(
      E2E_BUILD_PROJECT,
      [definition.id],
      undefined,
      undefined,
      minTime,
      maxTime,
      undefined,
      undefined,
      BuildStatus.Completed,
      undefined,
      undefined,
      undefined,
      BUILD_FETCH_TOP,
      undefined,
      undefined,
      undefined,
      BuildQueryOrder.FinishTimeAscending,
    );

    const builds = normalizePagedList<{ id?: number; buildNumber?: string; finishTime?: Date }>(buildsPage);
    buildsScanned = builds.length;
    const buildIds = builds.map(build => build.id).filter((id): id is number => typeof id === 'number');
    const storedBuildIds = await getStoredBuildIds(buildIds);
    buildsSynced = await syncMissingSnapshots(buildApi, builds, storedBuildIds, definition.name);
    snapshots = await getSnapshotsInRange(from, to);

    const buildsWithArtifacts = new Set(snapshots.map(snapshot => snapshot.buildId)).size;

    if (builds.length === 0 && snapshots.length === 0) {
      hint =
        `No completed builds in ${from}–${to}. Confirm the nightly pipeline has run and ADO_PAT has Build (Read) scope.`;
    } else if (builds.length > 0 && snapshots.length === 0 && buildsSynced === 0) {
      hint =
        `Checked ${builds.length} finished pipeline run(s); none had readable PlaywrightReport_* artifacts ` +
        `(index.html → report.json). Pipeline stage pass/fail is ignored — only parsed report stats count.`;
    } else if (buildsWithArtifacts > 0) {
      hint = undefined;
    }
  } catch (error) {
    if (snapshots.length === 0) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    hint = message.includes('(401)') || message.includes('401')
      ? 'Showing stored E2E snapshots only. Azure DevOps rejected the PAT while checking for newer pipeline artifacts.'
      : `Showing stored E2E snapshots only. Could not refresh from Azure DevOps: ${message}`;
  }

  const buildsWithArtifacts = new Set(snapshots.map(snapshot => snapshot.buildId)).size;

  return {
    from,
    to,
    definitionName,
    suites: E2E_SUITE_DEFINITIONS,
    snapshots,
    latestBySuite: buildLatestBySuite(snapshots),
    summary: {
      definitionId,
      buildsScanned,
      buildsWithArtifacts,
      hint,
    },
  };
}
