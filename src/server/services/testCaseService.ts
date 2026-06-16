import fs from 'fs';
import path from 'path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads, prds, testCases } from '../db/schema';
import type {
  TestCaseCoverageSummary,
  TestCaseRecord,
  TestCaseSummary,
  TestCaseStatus,
} from '../../shared/types/interview';
import { getDefaultModel } from './appSettingsService';
import {
  createThread,
  isThreadIdle,
  sendMessage,
  updateThreadKickoffContext,
} from './chatAgentService';
import { getSkillConfig } from './projectSettingsService';
import { notifyAiCompletion } from './aiCompletionNotifier';

const WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 360;

const activeTestCaseWatchers = new Map<
  string,
  ReturnType<typeof setInterval>
>();

function sanitizeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'prd';
}

function findAllOutputFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && pattern.test(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push(
          ...findAllOutputFiles(path.join(dir, entry.name), pattern)
        );
      }
    }
    results.sort();
    return results;
  } catch {
    return [];
  }
}

function findOutputFile(dir: string, pattern: RegExp): string | null {
  const all = findAllOutputFiles(dir, pattern);
  return all.length > 0 ? all[0] : null;
}

async function resolveOutputDir(threadId: string): Promise<string | null> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { workspaceDir: true },
  });
  return row?.workspaceDir
    ? path.join(row.workspaceDir, '.ai-pilot', 'output')
    : null;
}

async function cleanupWorkspace(
  threadId: string | null | undefined
): Promise<void> {
  if (!threadId) return;
  try {
    const row = await db.query.chatThreads.findFirst({
      where: eq(chatThreads.id, threadId),
      columns: { workspaceDir: true },
    });
    if (row?.workspaceDir) {
      fs.rmSync(row.workspaceDir, { recursive: true, force: true });
      console.log(
        `[testCaseWatcher] Cleaned up workspace for thread ${threadId}`
      );
    }
  } catch {
    /* non-fatal */
  }
}

async function readOutputBacklog(threadId: string): Promise<unknown | null> {
  const outputDir = await resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /\.backlog\.json$/i);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringFrom(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function countCaseLikeItems(value: unknown): number {
  if (Array.isArray(value)) {
    const caseLike = value.filter((item) => {
      const record = asRecord(item);
      return (
        record &&
        ('testCaseId' in record ||
          'test_case_id' in record ||
          'caseId' in record ||
          'steps' in record ||
          'expectedResult' in record ||
          'expected_result' in record)
      );
    });
    if (caseLike.length > 0) return caseLike.length;
    return value.reduce<number>(
      (sum, item) => sum + countCaseLikeItems(item),
      0
    );
  }

  const record = asRecord(value);
  if (!record) return 0;
  return Object.values(record).reduce<number>(
    (sum, item) => sum + countCaseLikeItems(item),
    0
  );
}

function extractCoverageSummary(
  testCasesJson: unknown
): TestCaseCoverageSummary | null {
  const root = asRecord(testCasesJson);
  const direct =
    asRecord(root?.coverageSummary) ??
    asRecord(root?.coverage_summary) ??
    asRecord(root?.summary);
  const matrix =
    asRecord(root?.coverageMatrix) ?? asRecord(root?.coverage_matrix);
  const acceptanceCriteria = Array.isArray(matrix?.acceptanceCriteria)
    ? matrix.acceptanceCriteria
    : [];
  const businessRules = Array.isArray(matrix?.businessRules)
    ? matrix.businessRules
    : [];
  const coveredPbis = new Set<string>();

  for (const item of acceptanceCriteria) {
    const record = asRecord(item);
    if (record?.covered === true) {
      const pbiId = stringFrom(record.pbiId) ?? stringFrom(record.pbi_id);
      if (pbiId) coveredPbis.add(pbiId);
    }
  }

  const totalCases =
    numberFrom(direct?.totalCases) ??
    numberFrom(direct?.total_cases) ??
    countCaseLikeItems(testCasesJson);
  const pbisCovered =
    numberFrom(direct?.pbisCovered) ??
    numberFrom(direct?.pbis_covered) ??
    coveredPbis.size;
  const acCovered =
    stringFrom(direct?.acCovered) ??
    stringFrom(direct?.ac_covered) ??
    `${acceptanceCriteria.filter((item) => asRecord(item)?.covered === true).length}/${acceptanceCriteria.length}`;
  const brCovered =
    stringFrom(direct?.brCovered) ??
    stringFrom(direct?.br_covered) ??
    `${businessRules.filter((item) => asRecord(item)?.covered === true).length}/${businessRules.length}`;
  const gapsValue = direct?.gaps ?? matrix?.gaps;
  const gaps =
    numberFrom(gapsValue) ?? (Array.isArray(gapsValue) ? gapsValue.length : 0);

  if (!direct && totalCases === 0) return null;
  return { totalCases, pbisCovered, acCovered, brCovered, gaps };
}

function arrayLengthFrom(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function extractSuiteTestCaseCounts(
  testCasesJson: unknown
): Map<string, number> {
  const counts = new Map<string, number>();
  const root = asRecord(testCasesJson);
  const suites = Array.isArray(root?.suites) ? root.suites : [];

  for (const suite of suites) {
    const record = asRecord(suite);
    if (!record) continue;

    const pbiId =
      stringFrom(record.pbiId) ??
      stringFrom(record.pbi_id) ??
      stringFrom(record.workItemId) ??
      stringFrom(record.work_item_id);
    if (!pbiId) continue;

    const count =
      numberFrom(record.testCaseCount) ??
      numberFrom(record.test_case_count) ??
      arrayLengthFrom(record.testCases) ??
      arrayLengthFrom(record.test_cases) ??
      arrayLengthFrom(record.cases);

    if (count !== null) counts.set(pbiId, count);
  }

  return counts;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function applyTestCaseCountsToBacklog(
  backlog: unknown,
  testCasesJson: unknown
): unknown | null {
  if (backlog === null || backlog === undefined) return null;

  const counts = extractSuiteTestCaseCounts(testCasesJson);
  if (counts.size === 0) return backlog;

  const cloned = cloneJson(backlog);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = asRecord(value);
    if (!record) return;

    const candidateIds = [
      stringFrom(record.pbiId),
      stringFrom(record.pbi_id),
      stringFrom(record.workItemId),
      stringFrom(record.work_item_id),
      stringFrom(record.id),
    ].filter((id): id is string => Boolean(id));

    const matchedId = candidateIds.find((id) => counts.has(id));
    if (matchedId) {
      record.testCaseCount = counts.get(matchedId) ?? record.testCaseCount;
    }

    Object.values(record).forEach(visit);
  };

  visit(cloned);
  return cloned;
}

function rowToRecord(row: typeof testCases.$inferSelect): TestCaseRecord {
  return {
    id: row.id,
    prdId: row.prdId,
    chatThreadId: row.chatThreadId ?? null,
    status: row.status as TestCaseStatus,
    testCasesJson: row.testCasesJson ?? undefined,
    testCasesMd: row.testCasesMd ?? null,
    coverageSummary: row.coverageSummary ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToSummary(row: typeof testCases.$inferSelect): TestCaseSummary {
  return {
    id: row.id,
    prdId: row.prdId,
    chatThreadId: row.chatThreadId ?? null,
    status: row.status as TestCaseStatus,
    coverageSummary: row.coverageSummary ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function markTestCaseFailed(
  testCaseId: string,
  prdId: string,
  chatThreadId: string
): Promise<void> {
  await db
    .update(testCases)
    .set({ status: 'failed', updatedAt: new Date().toISOString() })
    .where(
      and(eq(testCases.id, testCaseId), eq(testCases.status, 'generating'))
    );

  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.id, prdId),
    columns: { chatThreadId: true },
  });
  await cleanupWorkspace(chatThreadId);
  await cleanupWorkspace(prdRow?.chatThreadId);
}

export async function readOutputTestCases(
  threadId: string
): Promise<unknown | null> {
  const outputDir = await resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /\.test-cases\.json$/i);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export async function readOutputTestCasesMd(
  threadId: string
): Promise<string | null> {
  const outputDir = await resolveOutputDir(threadId);
  if (!outputDir) return null;
  const file = findOutputFile(outputDir, /\.test-cases\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

export async function triggerTestCaseGeneration(
  prdId: string,
  sourceThreadId: string
): Promise<boolean> {
  const prdRow = await db.query.prds.findFirst({
    where: eq(prds.id, prdId),
  });
  if (!prdRow) return false;

  const existingGenerating = await db.query.testCases.findFirst({
    where: and(eq(testCases.prdId, prdId), eq(testCases.status, 'generating')),
    columns: { id: true, chatThreadId: true },
  });
  if (existingGenerating) {
    console.log(
      `[testCase] Generation already active — testCaseId=${existingGenerating.id} prdId=${prdId}`
    );
    return true;
  }

  const skillConfig = await getSkillConfig(prdRow.project);
  if (!skillConfig?.testCaseSkillPath) {
    console.log(
      `[testCase] Skipping generation; no test-case skill configured (prdId=${prdId})`
    );
    return false;
  }

  const defaultModel = await getDefaultModel();
  const model = skillConfig.testCaseModel ?? defaultModel;
  const slug = sanitizeSlug(prdRow.title);
  const backlogJson = prdRow.backlogJson ?? {};
  const context = [
    '# Test Case Generation Context',
    `prd_id: ${prdId}`,
    `source_thread_id: ${sourceThreadId}`,
    '',
    `Write outputs to \`.ai-pilot/output/${slug}.test-cases.json\` and \`.ai-pilot/output/${slug}.test-cases.md\`.`,
    `Patch \`.ai-pilot/output/${slug}.backlog.json\` with \`testCaseCount\` for each PBI.`,
    '',
    'The PRD and backlog are also available as files in `.ai-pilot/output/`.',
    '',
    '## PRD',
    prdRow.content || '(empty)',
    '',
    '## Backlog JSON',
    '```json',
    JSON.stringify(backlogJson, null, 2),
    '```',
  ].join('\n');

  const thread = await createThread(
    prdRow.authorId,
    {
      project: prdRow.project,
      repo: skillConfig.skillRepo,
      branch: skillConfig.skillBranch ?? 'main',
      skillPath: skillConfig.testCaseSkillPath,
      freeformContext: context,
      model,
    },
    { skipAutoKickoff: true }
  );

  const outputDir = path.join(thread.workspaceDir, '.ai-pilot', 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, `${slug}.prd.md`),
    prdRow.content || '',
    'utf-8'
  );
  fs.writeFileSync(
    path.join(outputDir, `${slug}.backlog.json`),
    JSON.stringify(backlogJson, null, 2),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(thread.workspaceDir, '.ai-pilot', 'kickoff-context.md'),
    context,
    'utf-8'
  );
  updateThreadKickoffContext(thread.id, context);

  const [testCaseRow] = await db
    .insert(testCases)
    .values({
      prdId,
      chatThreadId: thread.id,
      status: 'generating',
    })
    .returning({ id: testCases.id });

  startTestCaseWatcher(testCaseRow.id, thread.id);

  void sendMessage(
    thread.id,
    'Generate QA test cases for the provided PRD and backlog. Use the configured skill instructions and write the required output files.',
    undefined,
    [],
    { hidden: true }
  ).catch((err: Error) => {
    console.error(
      `[testCase] Failed to start generation (testCaseId=${testCaseRow.id}, threadId=${thread.id})`,
      err
    );
    markTestCaseFailed(testCaseRow.id, prdId, thread.id).catch((markErr) => {
      console.error(
        `[testCase] Failed to mark generation failed (testCaseId=${testCaseRow.id})`,
        markErr
      );
    });
  });

  console.log(
    `[testCase] Started generation — testCaseId=${testCaseRow.id} prdId=${prdId} threadId=${thread.id}`
  );
  return true;
}

export function isTestCaseWatcherActive(testCaseId: string): boolean {
  return activeTestCaseWatchers.has(testCaseId);
}

export function startTestCaseWatcher(
  testCaseId: string,
  chatThreadId: string
): void {
  const active = activeTestCaseWatchers.get(testCaseId);
  if (active !== undefined) clearInterval(active);

  let attempts = 0;
  console.log(
    `[testCaseWatcher] Started — testCaseId=${testCaseId} threadId=${chatThreadId}`
  );

  const interval = setInterval(async () => {
    attempts += 1;

    const row = await db.query.testCases.findFirst({
      where: eq(testCases.id, testCaseId),
      columns: { id: true, prdId: true, chatThreadId: true, status: true },
    });
    if (
      !row ||
      row.status !== 'generating' ||
      row.chatThreadId !== chatThreadId
    ) {
      clearInterval(interval);
      activeTestCaseWatchers.delete(testCaseId);
      return;
    }

    const testCasesJson = await readOutputTestCases(chatThreadId);
    if (testCasesJson !== null) {
      clearInterval(interval);
      activeTestCaseWatchers.delete(testCaseId);
      await syncTestCaseOutput(testCaseId, row.prdId, chatThreadId);
      return;
    }

    if (attempts > WATCHER_MAX_ATTEMPTS || isThreadIdle(chatThreadId)) {
      clearInterval(interval);
      activeTestCaseWatchers.delete(testCaseId);
      console.warn(
        `[testCaseWatcher] No test-case output produced — marking failed (testCaseId=${testCaseId}, threadId=${chatThreadId})`
      );
      await markTestCaseFailed(testCaseId, row.prdId, chatThreadId);
    }
  }, WATCHER_INTERVAL_MS);

  activeTestCaseWatchers.set(testCaseId, interval);
}

export async function syncTestCaseOutput(
  testCaseId: string,
  prdId: string,
  chatThreadId: string
): Promise<boolean> {
  const testCasesJson = await readOutputTestCases(chatThreadId);
  if (testCasesJson === null) return false;

  const [currentRow, prdRow] = await Promise.all([
    db.query.testCases.findFirst({
      where: eq(testCases.id, testCaseId),
      columns: { chatThreadId: true, status: true },
    }),
    db.query.prds.findFirst({
      where: eq(prds.id, prdId),
      columns: { title: true, chatThreadId: true, backlogJson: true },
    }),
  ]);
  if (currentRow?.chatThreadId !== chatThreadId) {
    console.log(
      `[testCase] Discarded stale output — thread ${chatThreadId} is no longer active (testCaseId=${testCaseId})`
    );
    await cleanupWorkspace(chatThreadId);
    return false;
  }

  const testCasesMd = await readOutputTestCasesMd(chatThreadId);
  const patchedBacklog = await readOutputBacklog(chatThreadId);
  const backlogWithTestCaseCounts = applyTestCaseCountsToBacklog(
    patchedBacklog ?? prdRow?.backlogJson,
    testCasesJson
  );
  const coverageSummary = extractCoverageSummary(testCasesJson);
  const updates: Partial<typeof testCases.$inferInsert> = {
    status: 'ready',
    testCasesJson: testCasesJson as any,
    testCasesMd: testCasesMd ?? null,
    coverageSummary: coverageSummary ?? null,
    updatedAt: new Date().toISOString(),
  };

  await db.update(testCases).set(updates).where(eq(testCases.id, testCaseId));
  if (backlogWithTestCaseCounts !== null) {
    await db
      .update(prds)
      .set({
        backlogJson: backlogWithTestCaseCounts as any,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(prds.id, prdId));
  }

  await cleanupWorkspace(chatThreadId);
  await cleanupWorkspace(prdRow?.chatThreadId);
  console.log(
    `[testCase] Synced output to DB (testCaseId=${testCaseId}, prdId=${prdId})`
  );

  const prdTitle = prdRow?.title ?? 'Untitled PRD';
  notifyAiCompletion('test_cases_generated', testCaseId, { title: prdTitle }).catch(err =>
    console.error(`[testCase] AI notification failed for test_cases_generated (id=${testCaseId}):`, err),
  );

  // Test cases are the final artifact — check if PRD validation can now start
  try {
    const { arePrdValidationArtifactsReady, autoStartPrdValidation } = await import('./prdService');
    const ready = await arePrdValidationArtifactsReady(prdId);
    if (ready) {
      await autoStartPrdValidation(prdId);
    }
  } catch (err) {
    console.error(`[testCase] Failed to trigger PRD validation (prdId=${prdId})`, err);
  }

  return true;
}

export async function getTestCases(
  prdId: string
): Promise<TestCaseRecord | null> {
  const [row] = await db
    .select()
    .from(testCases)
    .where(eq(testCases.prdId, prdId))
    .orderBy(desc(testCases.createdAt))
    .limit(1);
  return row ? rowToRecord(row) : null;
}

export async function listLatestTestCaseSummariesForPrds(
  prdIds: string[]
): Promise<Map<string, TestCaseSummary>> {
  const uniquePrdIds = Array.from(new Set(prdIds)).filter(Boolean);
  const latestByPrd = new Map<string, TestCaseSummary>();
  if (uniquePrdIds.length === 0) return latestByPrd;

  const rows = await db
    .select()
    .from(testCases)
    .where(inArray(testCases.prdId, uniquePrdIds))
    .orderBy(desc(testCases.createdAt));

  for (const row of rows) {
    if (!latestByPrd.has(row.prdId)) {
      latestByPrd.set(row.prdId, rowToSummary(row));
    }
  }

  return latestByPrd;
}
