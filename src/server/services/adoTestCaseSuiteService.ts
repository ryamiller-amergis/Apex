import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads, qaAdoTestSuites } from '../db/schema';
import type { EffortLevel } from '../../shared/types/effort';
import type { TestCaseCoverageSummary } from '../../shared/types/interview';
import type { QaAdoGenerationContext, QaAdoGenerationItem } from '../../shared/types/qaLab';
import type { RunRef } from '../../shared/types/runGrounding';
import { getDefaultModel } from './appSettingsService';
import {
  canThisInstanceFailGeneration,
  isThreadRunAlive,
} from './agentRunReaperService';
import { adoWriteForRequest, adoWriteFromToken } from './adoFactory';
import { AzureDevOpsService } from './azureDevOps';
import { routeBackgroundWorkflow } from './backgroundWorkflowRouter';
import {
  createThread,
  isThreadIdle,
  prepareBackgroundWorkflowTurn,
  sendMessage,
  updateThreadKickoffContext,
} from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import {
  propagatePipelineGrounding,
  runGroundingService,
} from './runGroundingService';

export const ADO_TEST_SUITE_WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 360;
const QA_LAB_SCOPE_FILE = 'qa-lab-scope.json';
const NOT_SPECIFIED = 'Not specified on the Azure DevOps work item';

const activeAdoTestSuiteWatchers = new Map<string, ReturnType<typeof setInterval>>();

export interface QaAdoPublishedCase {
  localCaseId: string;
  adoTestCaseId: number;
  adoTestCaseUrl: string;
  parentWorkItemId: number;
  publishedAt: string;
}

export interface AdoTestSuiteRecord {
  id: string;
  project: string;
  rootWorkItemId: number;
  rootWorkItemType: string;
  rootTitle: string;
  status: string;
  chatThreadId: string | null;
  sourceSnapshot: QaAdoGenerationContext;
  testCasesJson: unknown;
  testCasesMd: string | null;
  coverageSummary: TestCaseCoverageSummary | null;
  publishedCases: QaAdoPublishedCase[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdoQaContextReader {
  getQaTestGenerationContext(
    rootId: number,
  ): Promise<QaAdoGenerationContext | null>;
}

export interface TriggerAdoTestCaseGenerationInput {
  project: string;
  rootWorkItemId: number;
  userId: string;
  /** Interview or chat thread whose grounding should be copied onto the generation run. */
  sourceThreadId?: string;
  model?: string;
  effort?: EffortLevel;
  skillSettingsId?: string;
  /** Reader override. Defaults to AzureDevOpsService for the project. */
  ado?: AdoQaContextReader;
}

export type TriggerAdoTestCaseGenerationResult =
  | { started: true; suiteId: string; threadId: string }
  | {
      started: false;
      reason:
        | 'root-not-found'
        | 'no-targets'
        | 'already-generating'
        | 'skill-not-configured'
        | 'routing-failed';
      suiteId?: string;
    };

export interface SyntheticAdoAcceptanceCriterion {
  given: string;
  when: string;
  then: string;
}

export interface SyntheticAdoPbiItem {
  type: 'PBI';
  id: string;
  title: string;
  priority: 'Must Have';
  dependsOn: string[];
  parallelGroup: null;
  userStory: { persona: 'QA'; iWant: string; soThat: string };
  businessRules: string[];
  nonFunctionalRequirements: {
    performance: string;
    accessibility: string;
    security: string;
  };
  outOfScope: string[];
  acceptanceCriteria: SyntheticAdoAcceptanceCriterion[];
}

export interface SyntheticAdoTbiItem {
  type: 'TBI';
  id: string;
  title: string;
  priority: 'Must Have';
  dependsOn: string[];
  parallelGroup: null;
  description: string;
  technicalDependencies: string[];
  nonFunctionalRequirements: string[];
  definitionOfDone: string[];
}

export interface SyntheticAdoBacklog {
  personas: Array<{ name: 'QA'; type: 'Internal'; description: string }>;
  businessRules: [];
  epics: Array<{
    title: string;
    priority: 'Must Have';
    description: string;
    successMetrics: string[];
    outOfScope: string[];
    assumptions: string[];
    dependencies: string[];
    features: Array<{
      id: 'FEAT-001';
      title: string;
      priority: 'Must Have';
      description: string;
      affectedPersonas: ['QA'];
      outOfScope: string[];
      dependsOn: [];
      items: Array<SyntheticAdoPbiItem | SyntheticAdoTbiItem>;
    }>;
  }>;
  implementationPhases: Array<{ phase: 1; epics: string[]; rationale: string }>;
  assumptionsMade: string[];
}

export interface AdoTestCaseWriter {
  createTestCaseWorkItem(spec: {
    title: string;
    stepsHtml: string;
    parentId: number;
    assignedTo?: string;
    linkType?: 'hierarchy' | 'tested-by';
  }): Promise<{ id: number; url: string }>;
}

export interface PublishAdoTestCasesOptions {
  /** Local case ids to publish. Omit to publish every unpublished case. */
  localCaseIds?: string[];
  assignedTo?: string;
  /** Injected writer. Used before the request and token options. */
  ado?: AdoTestCaseWriter;
  req?: Request;
  /** Passed to adoWriteFromToken. Null uses that helper's non-production PAT fallback. */
  adoToken?: string | null;
}

export interface PublishAdoTestCasesResult {
  published: QaAdoPublishedCase[];
  skippedLocalCaseIds: string[];
  failures: Array<{ localCaseId: string; message: string }>;
}

interface PublishableCase {
  localCaseId: string;
  title: string;
  steps: Array<string | { action: string; expected?: string }>;
  parentWorkItemId: number;
}

/** Backlog id the create-test-case skill can trace. The number is the ADO work item id. */
export function adoBacklogPbiId(adoWorkItemId: number): string {
  return `PBI-${adoWorkItemId}`;
}

export function adoBacklogTbiId(adoWorkItemId: number): string {
  return `TBI-${adoWorkItemId}`;
}

export function buildSyntheticAdoBacklog(
  context: QaAdoGenerationContext,
): SyntheticAdoBacklog {
  const targets = [...context.targets].sort((left, right) => left.id - right.id);
  const technicalContext = [...context.technicalContext].sort(
    (left, right) => left.id - right.id,
  );
  const epicTitle = nonEmpty(context.root.title, `Work item ${context.root.id}`);
  const featureTitle = context.root.workItemType === 'Feature'
    ? epicTitle
    : 'Requirements';
  const rootDescription = nonEmpty(
    plainText(context.root.description),
    `Azure DevOps ${context.root.workItemType} ${context.root.id}.`,
  );

  const pbiItems = targets.map((target) => toSyntheticPbi(target, technicalContext));
  const tbiItems = technicalContext.map(toSyntheticTbi);

  return {
    personas: [{
      name: 'QA',
      type: 'Internal',
      description: 'Quality engineer verifying the Azure DevOps work items in this suite.',
    }],
    businessRules: [],
    epics: [{
      title: epicTitle,
      priority: 'Must Have',
      description: rootDescription,
      successMetrics: [
        'Each in-scope Azure DevOps PBI or Bug has at least one traced test case.',
      ],
      outOfScope: ['Work items outside this Azure DevOps hierarchy'],
      assumptions: [
        'Acceptance criteria and repro steps were copied from Azure DevOps at generation time.',
      ],
      dependencies: ['None'],
      features: [{
        id: 'FEAT-001',
        title: featureTitle,
        priority: 'Must Have',
        description: rootDescription,
        affectedPersonas: ['QA'],
        outOfScope: ['Work items outside this Azure DevOps hierarchy'],
        dependsOn: [],
        items: [...pbiItems, ...tbiItems],
      }],
    }],
    implementationPhases: [{
      phase: 1,
      epics: [epicTitle],
      rationale: 'The suite covers one Azure DevOps hierarchy captured for QA generation.',
    }],
    assumptionsMade: [
      'PBIs and Bugs are represented as PBI-{azureDevOpsId} so generated cases can be linked back to the source work item.',
      'Technical Backlog Items are context only and do not receive their own test cases.',
    ],
  };
}

export function isAdoTestSuiteWatcherActive(suiteId: string): boolean {
  return activeAdoTestSuiteWatchers.has(suiteId);
}

export function resetAdoTestSuiteWatchersForTests(): void {
  for (const interval of activeAdoTestSuiteWatchers.values()) clearInterval(interval);
  activeAdoTestSuiteWatchers.clear();
}

export async function triggerAdoTestCaseGeneration(
  input: TriggerAdoTestCaseGenerationInput,
): Promise<TriggerAdoTestCaseGenerationResult> {
  const project = input.project.trim();
  if (!project) throw new Error('project is required');
  if (!Number.isInteger(input.rootWorkItemId) || input.rootWorkItemId <= 0) {
    throw new Error('rootWorkItemId must be a positive integer');
  }
  const userId = input.userId.trim();
  if (!userId) throw new Error('userId is required');

  const existing = await db.query.qaAdoTestSuites.findFirst({
    where: and(
      eq(qaAdoTestSuites.project, project),
      eq(qaAdoTestSuites.rootWorkItemId, input.rootWorkItemId),
      eq(qaAdoTestSuites.status, 'generating'),
    ),
    columns: { id: true },
  });
  if (existing) {
    return { started: false, reason: 'already-generating', suiteId: existing.id };
  }

  const skillConfig = await resolveSkillConfig({
    project,
    settingsId: input.skillSettingsId,
  });
  if (!skillConfig?.testCaseSkillPath || !skillConfig.skillRepo) {
    return { started: false, reason: 'skill-not-configured' };
  }

  const reader = input.ado ?? new AzureDevOpsService(project);
  const context = await reader.getQaTestGenerationContext(input.rootWorkItemId);
  if (!context) return { started: false, reason: 'root-not-found' };
  if (context.targets.length === 0) return { started: false, reason: 'no-targets' };

  const backlog = buildSyntheticAdoBacklog(context);
  const pbiIds = backlog.epics[0].features[0].items
    .filter((item): item is SyntheticAdoPbiItem => item.type === 'PBI')
    .map((item) => item.id);
  const slug = sanitizeSlug(context.root.title);
  const prdMarkdown = renderSyntheticPrd(context, pbiIds);
  const kickoffMessage = buildKickoffMessage(pbiIds);
  const freeformContext = renderGenerationContext({
    project,
    rootWorkItemId: input.rootWorkItemId,
    slug,
    prdMarkdown,
    backlog,
  });
  const model = input.model
    ?? skillConfig.testCaseModel
    ?? await getDefaultModel();
  const effort = input.effort ?? skillConfig.testCaseEffort ?? undefined;

  const thread = await createThread(
    userId,
    {
      project,
      agentModule: 'testCase',
      repo: skillConfig.skillRepo,
      branch: skillConfig.skillBranch ?? 'main',
      skillProvider: skillConfig.skillProvider,
      skillPath: skillConfig.testCaseSkillPath,
      skillSettingsId: input.skillSettingsId,
      freeformContext,
      model,
      effort,
    },
    { skipAutoKickoff: true },
  );
  if (!thread.workspaceDir) {
    throw new Error('Test-case generation thread has no workspace');
  }

  writeGenerationWorkspace({
    workspaceDir: thread.workspaceDir,
    slug,
    prdMarkdown,
    backlog,
    pbiIds,
    freeformContext,
  });
  updateThreadKickoffContext(thread.id, freeformContext);

  const [inserted] = await db
    .insert(qaAdoTestSuites)
    .values({
      project,
      rootWorkItemId: context.root.id,
      rootWorkItemType: context.root.workItemType,
      rootTitle: nonEmpty(context.root.title, `Work item ${context.root.id}`),
      status: 'generating',
      chatThreadId: thread.id,
      sourceSnapshot: context,
      createdBy: userId,
    })
    .returning({ id: qaAdoTestSuites.id });
  if (!inserted) throw new Error('Failed to persist the ADO test suite');

  const destinationRun: RunRef = {
    runType: 'chat',
    runId: thread.id,
    project,
  };
  const reportPreparationFailure = async (): Promise<void> => {
    await runGroundingService.persistThenMarkTerminalInactive(
      destinationRun,
      () => markAdoTestSuiteFailed(inserted.id, thread.id, thread.workspaceDir),
    );
  };

  try {
    await routeBackgroundWorkflow({
      userId,
      workflowClass: 'test-cases',
      destinationRun,
      threadId: thread.id,
      prepareWorker: async () => {
        if (input.sourceThreadId) {
          try {
            await propagatePipelineGrounding(
              { runType: 'chat', runId: input.sourceThreadId, project },
              destinationRun,
              userId,
              { deferMaterialization: true },
            );
          } catch {
            console.warn(
              `[adoTestSuite] Grounding propagation unavailable (suiteId=${inserted.id})`,
            );
          }
        }
        const prepared = await prepareBackgroundWorkflowTurn(thread.id, kickoffMessage);
        const targetGrounding = (
          await runGroundingService.getGroundings(destinationRun)
        ).find((grounding) => grounding.repoRole === 'target' && grounding.isActive);
        return { ...prepared, targetGrounding };
      },
      runInProcess: () => sendMessage(
        thread.id,
        kickoffMessage,
        undefined,
        [],
        { hidden: true },
      ),
      reportRecoverablePreparationFailure: reportPreparationFailure,
    });
  } catch (error) {
    console.error(
      `[adoTestSuite] Routing failed (suiteId=${inserted.id})`,
      error,
    );
    await reportPreparationFailure();
    return { started: false, reason: 'routing-failed', suiteId: inserted.id };
  }

  startAdoTestSuiteWatcher(inserted.id, thread.id);
  console.log(
    `[adoTestSuite] Started generation — suiteId=${inserted.id} rootWorkItemId=${context.root.id} threadId=${thread.id}`,
  );
  return { started: true, suiteId: inserted.id, threadId: thread.id };
}

export async function getLatestAdoTestSuite(
  project?: string,
  rootWorkItemId?: number,
  suiteId?: string,
): Promise<AdoTestSuiteRecord | null> {
  if (suiteId) {
    const row = await loadSuite(suiteId);
    return row ? toAdoTestSuiteRecord(row) : null;
  }
  if (!project || !Number.isInteger(rootWorkItemId) || (rootWorkItemId ?? 0) <= 0) {
    return null;
  }
  const row = await db.query.qaAdoTestSuites.findFirst({
    where: and(
      eq(qaAdoTestSuites.project, project),
      eq(qaAdoTestSuites.rootWorkItemId, rootWorkItemId as number),
    ),
    orderBy: (table, helpers) => [helpers.desc(table.createdAt)],
  });
  return row ? toAdoTestSuiteRecord(row) : null;
}

/**
 * Creates ADO Test Case work items for a ready suite.
 * Generation never calls this. Retries skip local case ids already stored on the suite.
 */
export async function publishAdoTestCases(
  suiteId: string,
  adoOrOptions?: AdoTestCaseWriter | PublishAdoTestCasesOptions,
): Promise<PublishAdoTestCasesResult> {
  const options = publishOptionsFrom(adoOrOptions);
  const row = await loadSuite(suiteId);
  if (!row) throw new Error(`ADO test suite ${suiteId} was not found`);
  if (row.status !== 'ready') {
    throw new Error(
      `ADO test suite ${suiteId} is ${row.status}; publish waits until generation is ready`,
    );
  }

  const cases = collectPublishableCases(row.testCasesJson);
  if (cases.length === 0 && options.localCaseIds === undefined) {
    throw new Error(`ADO test suite ${suiteId} has no generated test cases to publish`);
  }
  if (options.localCaseIds?.length === 0) {
    return { published: [], skippedLocalCaseIds: [], failures: [] };
  }

  const byId = new Map(cases.map((testCase) => [testCase.localCaseId, testCase]));
  const requested = options.localCaseIds ?? cases.map((testCase) => testCase.localCaseId);
  const writer = await resolveTestCaseWriter(row.project, row.sourceSnapshot, options);
  const published: QaAdoPublishedCase[] = [];
  const skippedLocalCaseIds: string[] = [];
  const failures: PublishAdoTestCasesResult['failures'] = [];
  const seen = new Set<string>();

  for (const localCaseId of requested) {
    if (seen.has(localCaseId)) continue;
    seen.add(localCaseId);

    const latest = await loadSuite(suiteId);
    if (!latest) throw new Error(`ADO test suite ${suiteId} was not found`);
    const stored = publishedCasesFrom(latest.publishedCases);
    if (stored.some((item) => item.localCaseId === localCaseId)) {
      skippedLocalCaseIds.push(localCaseId);
      continue;
    }

    const testCase = byId.get(localCaseId);
    if (!testCase) {
      failures.push({
        localCaseId,
        message: 'Test case was not found in the generated suite',
      });
      continue;
    }

    try {
      const created = await writer.createTestCaseWorkItem({
        title: testCase.title,
        stepsHtml: buildTestCaseStepsXml(testCase.steps),
        parentId: testCase.parentWorkItemId,
        linkType: 'tested-by',
        ...(options.assignedTo ? { assignedTo: options.assignedTo } : {}),
      });
      const publishedAt = new Date().toISOString();
      const entry: QaAdoPublishedCase = {
        localCaseId,
        adoTestCaseId: created.id,
        adoTestCaseUrl: created.url,
        parentWorkItemId: testCase.parentWorkItemId,
        publishedAt,
      };
      const refreshed = publishedCasesFrom((await loadSuite(suiteId))?.publishedCases);
      if (!refreshed.some((item) => item.localCaseId === localCaseId)) {
        refreshed.push(entry);
        await db
          .update(qaAdoTestSuites)
          .set({ publishedCases: refreshed, updatedAt: publishedAt })
          .where(eq(qaAdoTestSuites.id, suiteId));
      }
      published.push(entry);
    } catch (error) {
      failures.push({
        localCaseId,
        message: error instanceof Error ? error.message : 'Test case publish failed',
      });
    }
  }

  return { published, skippedLocalCaseIds, failures };
}

export async function syncAdoTestSuiteOutput(
  suiteId: string,
  chatThreadId: string,
): Promise<boolean> {
  const testCasesJson = await readOutputTestCases(chatThreadId);
  if (testCasesJson === null) return false;

  const row = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, suiteId),
    columns: { chatThreadId: true, status: true },
  });
  if (!row || row.chatThreadId !== chatThreadId || row.status !== 'generating') {
    await cleanupWorkspace(chatThreadId);
    return false;
  }

  const testCasesMd = await readOutputTestCasesMd(chatThreadId);
  const coverageSummary = summarizeCoverage(testCasesJson);
  const updated = await db
    .update(qaAdoTestSuites)
    .set({
      status: 'ready',
      testCasesJson,
      testCasesMd,
      coverageSummary,
      updatedAt: new Date().toISOString(),
    })
    .where(and(
      eq(qaAdoTestSuites.id, suiteId),
      eq(qaAdoTestSuites.chatThreadId, chatThreadId),
      eq(qaAdoTestSuites.status, 'generating'),
    ))
    .returning({ id: qaAdoTestSuites.id });

  await cleanupWorkspace(chatThreadId);
  if (updated.length === 0) return false;
  console.log(`[adoTestSuite] Synced output (suiteId=${suiteId})`);
  return true;
}

function toSyntheticPbi(
  target: QaAdoGenerationItem,
  technicalContext: QaAdoGenerationItem[],
): SyntheticAdoPbiItem {
  const sourceText = target.workItemType === 'Bug'
    ? target.acceptanceCriteria || target.reproSteps || target.description
    : target.acceptanceCriteria || target.description;
  const description = plainText(target.description);
  return {
    type: 'PBI',
    id: adoBacklogPbiId(target.id),
    title: nonEmpty(target.title, `Work item ${target.id}`),
    priority: 'Must Have',
    dependsOn: technicalContext
      .filter((item) => item.parentId === target.id)
      .map((item) => adoBacklogTbiId(item.id)),
    parallelGroup: null,
    userStory: {
      persona: 'QA',
      iWant: `confirm "${nonEmpty(target.title, `work item ${target.id}`)}" behaves as specified in Azure DevOps`,
      soThat: nonEmpty(description, `Azure DevOps work item ${target.id} is verified`),
    },
    businessRules: [],
    nonFunctionalRequirements: {
      performance: NOT_SPECIFIED,
      accessibility: NOT_SPECIFIED,
      security: NOT_SPECIFIED,
    },
    outOfScope: [`Behavior not described on Azure DevOps work item ${target.id}`],
    acceptanceCriteria: toAcceptanceCriteria(
      sourceText,
      nonEmpty(target.title, `Work item ${target.id}`),
    ),
  };
}

function toSyntheticTbi(item: QaAdoGenerationItem): SyntheticAdoTbiItem {
  const description = nonEmpty(
    plainText(item.description),
    `Technical context from Azure DevOps work item ${item.id}.`,
  );
  return {
    type: 'TBI',
    id: adoBacklogTbiId(item.id),
    title: nonEmpty(item.title, `Work item ${item.id}`),
    priority: 'Must Have',
    dependsOn: [],
    parallelGroup: null,
    description,
    technicalDependencies: [`Azure DevOps work item ${item.id}`],
    nonFunctionalRequirements: [],
    definitionOfDone: [
      description,
      `Technical context only — Azure DevOps work item ${item.id}`,
      'Do not author a separate test case for this Technical Backlog Item',
    ],
  };
}

function toAcceptanceCriteria(
  raw: string,
  fallbackTitle: string,
): SyntheticAdoAcceptanceCriterion[] {
  const lines = stripHtml(raw).split('\n').map(cleanCriterionLine).filter(Boolean);
  const criteria: SyntheticAdoAcceptanceCriterion[] = [];
  let given = '';
  let when = '';
  let thenParts: string[] = [];

  const flush = (): void => {
    if (!given && !when && thenParts.length === 0) return;
    criteria.push({
      given: given || 'The work item is in scope',
      when: when || 'The behavior is exercised',
      then: thenParts.join(' ') || fallbackTitle,
    });
    given = '';
    when = '';
    thenParts = [];
  };

  for (const line of lines) {
    const inline = /^given\s+(.+?)\s+when\s+(.+?)\s+then\s+(.+)$/i.exec(line);
    if (inline) {
      flush();
      criteria.push({ given: inline[1], when: inline[2], then: inline[3] });
      continue;
    }
    const givenMatch = /^given\s+(.+)$/i.exec(line);
    if (givenMatch) {
      flush();
      given = givenMatch[1];
      continue;
    }
    const whenMatch = /^when\s+(.+)$/i.exec(line);
    if (whenMatch) {
      when = whenMatch[1];
      continue;
    }
    const thenMatch = /^then\s+(.+)$/i.exec(line);
    if (thenMatch) {
      thenParts.push(thenMatch[1]);
      continue;
    }
    if (given || when) {
      thenParts.push(line);
      continue;
    }
    criteria.push({
      given: 'The work item is in scope',
      when: 'The behavior is exercised',
      then: line,
    });
  }
  flush();

  if (criteria.length === 0) {
    criteria.push({
      given: 'The work item is in scope',
      when: 'The behavior is exercised',
      then: fallbackTitle,
    });
  }
  return criteria;
}

function renderSyntheticPrd(
  context: QaAdoGenerationContext,
  pbiIds: string[],
): string {
  const sections = [
    `# ${nonEmpty(context.root.title, `Work item ${context.root.id}`)}`,
    '',
    `Azure DevOps ${context.root.workItemType} ${context.root.id}.`,
    '',
    '## Description',
    plainText(context.root.description) || '(empty)',
    '',
    '## In-scope backlog items',
    ...pbiIds.map((pbiId) => `- ${pbiId}`),
  ];
  return sections.join('\n');
}

function renderGenerationContext(input: {
  project: string;
  rootWorkItemId: number;
  slug: string;
  prdMarkdown: string;
  backlog: SyntheticAdoBacklog;
}): string {
  return [
    '# Test Case Generation Context',
    `project: ${input.project}`,
    `root_work_item_id: ${input.rootWorkItemId}`,
    '',
    '## CRITICAL: Output File Instructions',
    '',
    'You MUST write the following output files using the built-in file writing tool (Write / create_file / edit_file).',
    'Do NOT use shell commands, Python scripts, or any other method to create these files.',
    '',
    'Required output files:',
    `1. \`.ai-pilot/output/${input.slug}.test-cases.json\` — the test cases in JSON format`,
    `2. \`.ai-pilot/output/${input.slug}.test-cases.md\` — the test cases in markdown format`,
    `3. Patch \`.ai-pilot/output/${input.slug}.backlog.json\` with \`testCaseCount\` for each PBI`,
    '',
    '## Synthetic PRD',
    input.prdMarkdown,
    '',
    '## Backlog JSON',
    '```json',
    JSON.stringify(input.backlog, null, 2),
    '```',
  ].join('\n');
}

function buildKickoffMessage(pbiIds: string[]): string {
  if (pbiIds.length === 1) {
    return `Generate QA test cases for backlog item ${pbiIds[0]} only. Use --pbi ${pbiIds[0]}. Do not write cases for any other PBI. Write the required output files.`;
  }
  return `Generate QA test cases only for these backlog items: ${pbiIds.join(', ')}. Do not write cases for any other PBI. Write the required output files.`;
}

function writeGenerationWorkspace(input: {
  workspaceDir: string;
  slug: string;
  prdMarkdown: string;
  backlog: SyntheticAdoBacklog;
  pbiIds: string[];
  freeformContext: string;
}): void {
  const outputDir = path.join(input.workspaceDir, '.ai-pilot', 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, `${input.slug}.prd.md`), input.prdMarkdown, 'utf-8');
  fs.writeFileSync(
    path.join(outputDir, `${input.slug}.backlog.json`),
    JSON.stringify(input.backlog, null, 2),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(outputDir, QA_LAB_SCOPE_FILE),
    JSON.stringify({ pbiIds: input.pbiIds }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(input.workspaceDir, '.ai-pilot', 'kickoff-context.md'),
    input.freeformContext,
    'utf-8',
  );
}

function startAdoTestSuiteWatcher(suiteId: string, chatThreadId: string): void {
  const active = activeAdoTestSuiteWatchers.get(suiteId);
  if (active !== undefined) clearInterval(active);

  let attempts = 0;
  const interval = setInterval(() => {
    attempts += 1;
    void pollAdoTestSuite(suiteId, chatThreadId, attempts).catch((error: unknown) => {
      console.error(`[adoTestSuiteWatcher] Tick failed (suiteId=${suiteId})`, error);
    });
  }, ADO_TEST_SUITE_WATCHER_INTERVAL_MS);
  interval.unref();
  activeAdoTestSuiteWatchers.set(suiteId, interval);
  console.log(`[adoTestSuiteWatcher] Started — suiteId=${suiteId} threadId=${chatThreadId}`);
}

async function pollAdoTestSuite(
  suiteId: string,
  chatThreadId: string,
  attempts: number,
): Promise<void> {
  const row = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, suiteId),
    columns: { status: true, chatThreadId: true },
  });
  if (!row || row.status !== 'generating' || row.chatThreadId !== chatThreadId) {
    stopAdoTestSuiteWatcher(suiteId);
    return;
  }

  if (await syncAdoTestSuiteOutput(suiteId, chatThreadId)) {
    stopAdoTestSuiteWatcher(suiteId);
    return;
  }

  if (attempts > WATCHER_MAX_ATTEMPTS) {
    stopAdoTestSuiteWatcher(suiteId);
    console.warn(
      `[adoTestSuiteWatcher] Timed out waiting for test-case output (suiteId=${suiteId})`,
    );
    await markAdoTestSuiteFailed(suiteId, chatThreadId);
    return;
  }

  const agentFinished = isThreadIdle(chatThreadId) && !(await isThreadRunAlive(chatThreadId));
  if (!agentFinished) return;
  if (!(await canThisInstanceFailGeneration(chatThreadId))) return;

  stopAdoTestSuiteWatcher(suiteId);
  console.warn(`[adoTestSuiteWatcher] No test-case output produced (suiteId=${suiteId})`);
  await markAdoTestSuiteFailed(suiteId, chatThreadId);
}

function stopAdoTestSuiteWatcher(suiteId: string): void {
  const active = activeAdoTestSuiteWatchers.get(suiteId);
  if (active !== undefined) clearInterval(active);
  activeAdoTestSuiteWatchers.delete(suiteId);
}

async function markAdoTestSuiteFailed(
  suiteId: string,
  chatThreadId: string,
  workspaceDir?: string,
): Promise<void> {
  await db
    .update(qaAdoTestSuites)
    .set({ status: 'failed', updatedAt: new Date().toISOString() })
    .where(and(
      eq(qaAdoTestSuites.id, suiteId),
      eq(qaAdoTestSuites.chatThreadId, chatThreadId),
      eq(qaAdoTestSuites.status, 'generating'),
    ));
  await cleanupWorkspace(chatThreadId, workspaceDir);
}

async function loadSuite(suiteId: string) {
  return db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, suiteId),
  });
}

function toAdoTestSuiteRecord(
  row: typeof qaAdoTestSuites.$inferSelect,
): AdoTestSuiteRecord {
  return {
    id: row.id,
    project: row.project,
    rootWorkItemId: row.rootWorkItemId,
    rootWorkItemType: row.rootWorkItemType,
    rootTitle: row.rootTitle,
    status: row.status,
    chatThreadId: row.chatThreadId,
    sourceSnapshot: generationContextFrom(row.sourceSnapshot),
    testCasesJson: row.testCasesJson,
    testCasesMd: row.testCasesMd,
    coverageSummary: row.coverageSummary ?? null,
    publishedCases: publishedCasesFrom(row.publishedCases),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function publishOptionsFrom(
  adoOrOptions: AdoTestCaseWriter | PublishAdoTestCasesOptions | undefined,
): PublishAdoTestCasesOptions {
  if (!adoOrOptions) return {};
  if (isTestCaseWriter(adoOrOptions)) return { ado: adoOrOptions };
  return adoOrOptions;
}

function isTestCaseWriter(
  value: AdoTestCaseWriter | PublishAdoTestCasesOptions,
): value is AdoTestCaseWriter {
  return typeof (value as AdoTestCaseWriter).createTestCaseWorkItem === 'function';
}

function generationContextFrom(value: unknown): QaAdoGenerationContext {
  const record = asRecord(value);
  const root = generationItemFrom(asRecord(record?.root));
  if (!root) {
    return {
      root: {
        id: 0,
        parentId: null,
        workItemType: 'Unknown',
        title: '',
        state: '',
        areaPath: '',
        description: '',
        acceptanceCriteria: '',
        reproSteps: '',
      },
      targets: [],
      technicalContext: [],
    };
  }
  return {
    root,
    targets: generationItemsFrom(record?.targets),
    technicalContext: generationItemsFrom(record?.technicalContext),
  };
}

function generationItemsFrom(value: unknown): QaAdoGenerationItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = generationItemFrom(asRecord(item));
    return parsed ? [parsed] : [];
  });
}

function generationItemFrom(
  record: Record<string, unknown> | null,
): QaAdoGenerationItem | null {
  if (
    !record
    || typeof record.id !== 'number'
    || typeof record.workItemType !== 'string'
    || typeof record.title !== 'string'
  ) {
    return null;
  }
  return {
    id: record.id,
    parentId: typeof record.parentId === 'number' ? record.parentId : null,
    workItemType: record.workItemType,
    title: record.title,
    state: stringFrom(record.state) ?? '',
    areaPath: stringFrom(record.areaPath) ?? '',
    description: stringFrom(record.description) ?? '',
    acceptanceCriteria: stringFrom(record.acceptanceCriteria) ?? '',
    reproSteps: stringFrom(record.reproSteps) ?? '',
  };
}

async function resolveTestCaseWriter(
  project: string,
  sourceSnapshot: unknown,
  options: PublishAdoTestCasesOptions,
): Promise<AdoTestCaseWriter> {
  if (options.ado) return options.ado;
  const areaPath = areaPathFromSnapshot(sourceSnapshot);
  if (options.req) return adoWriteForRequest(options.req, project, areaPath);
  if (options.adoToken !== undefined) return adoWriteFromToken(options.adoToken, project, areaPath);
  throw new Error(
    'An Azure DevOps write client, request, or token is required to publish test cases',
  );
}

function areaPathFromSnapshot(snapshot: unknown): string | undefined {
  const root = asRecord(asRecord(snapshot)?.root);
  const areaPath = stringFrom(root?.areaPath)?.trim();
  return areaPath ? areaPath : undefined;
}

function collectPublishableCases(testCasesJson: unknown): PublishableCase[] {
  const root = asRecord(testCasesJson);
  if (!root) return [];
  const suites = Array.isArray(root.suites) ? root.suites : [];
  const found: PublishableCase[] = [];
  const seen = new Set<string>();

  for (const suiteValue of suites) {
    const suite = asRecord(suiteValue);
    if (!suite) continue;
    const parentWorkItemId = parentIdFromSuite(suite);
    if (parentWorkItemId === null) continue;
    const pbiId = stringFrom(suite.pbiId)
      ?? stringFrom(suite.pbi_id)
      ?? adoBacklogPbiId(parentWorkItemId);
    const cases = suite.testCases ?? suite.test_cases ?? suite.cases;
    if (!Array.isArray(cases)) continue;
    cases.forEach((value, index) => {
      const testCase = toPublishableCase(value, pbiId, parentWorkItemId, index);
      if (!testCase || seen.has(testCase.localCaseId)) return;
      seen.add(testCase.localCaseId);
      found.push(testCase);
    });
  }

  return found;
}

function parentIdFromSuite(suite: Record<string, unknown>): number | null {
  const explicit = numberFrom(suite.adoWorkItemId) ?? numberFrom(suite.ado_work_item_id);
  if (explicit !== null) return explicit;
  const pbiId = stringFrom(suite.pbiId) ?? stringFrom(suite.pbi_id) ?? '';
  const match = /^PBI-(\d+)$/i.exec(pbiId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

function toPublishableCase(
  value: unknown,
  pbiId: string,
  parentWorkItemId: number,
  index: number,
): PublishableCase | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = stringFrom(record.title) ?? stringFrom(record.name);
  if (!title) return null;
  const localCaseId = stringFrom(record.id)
    ?? stringFrom(record.testCaseId)
    ?? stringFrom(record.test_case_id)
    ?? stringFrom(record.caseId)
    ?? `${pbiId}-${index + 1}`;
  return {
    localCaseId,
    title,
    steps: stepsFrom(record.steps),
    parentWorkItemId,
  };
}

function stepsFrom(value: unknown): PublishableCase['steps'] {
  if (!Array.isArray(value)) return [];
  const steps: PublishableCase['steps'] = [];
  for (const step of value) {
    if (typeof step === 'string') {
      steps.push(step);
      continue;
    }
    const record = asRecord(step);
    const action = stringFrom(record?.action);
    if (!action) continue;
    const expected = stringFrom(record?.expected);
    steps.push(expected === null ? { action } : { action, expected });
  }
  return steps;
}

function summarizeCoverage(testCasesJson: unknown): TestCaseCoverageSummary | null {
  const root = asRecord(testCasesJson);
  const direct = asRecord(root?.coverageSummary) ?? asRecord(root?.coverage_summary);
  const cases = collectPublishableCases(testCasesJson);
  if (!direct && cases.length === 0) return null;
  const parents = new Set(cases.map((testCase) => testCase.parentWorkItemId));
  return {
    totalCases: cases.length > 0
      ? cases.length
      : numberFrom(direct?.totalCases) ?? numberFrom(direct?.total_cases) ?? 0,
    pbisCovered: parents.size > 0
      ? parents.size
      : numberFrom(direct?.pbisCovered) ?? numberFrom(direct?.pbis_covered) ?? 0,
    acCovered: stringFrom(direct?.acCovered) ?? stringFrom(direct?.ac_covered) ?? '0/0',
    brCovered: stringFrom(direct?.brCovered) ?? stringFrom(direct?.br_covered) ?? '0/0',
    gaps: numberFrom(direct?.gaps) ?? 0,
  };
}

function publishedCasesFrom(value: unknown): QaAdoPublishedCase[] {
  if (!Array.isArray(value)) return [];
  const cases: QaAdoPublishedCase[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const localCaseId = stringFrom(record?.localCaseId);
    const adoTestCaseId = numberFrom(record?.adoTestCaseId);
    const adoTestCaseUrl = stringFrom(record?.adoTestCaseUrl);
    const parentWorkItemId = numberFrom(record?.parentWorkItemId);
    const publishedAt = stringFrom(record?.publishedAt);
    if (
      !localCaseId
      || adoTestCaseId === null
      || !adoTestCaseUrl
      || parentWorkItemId === null
      || !publishedAt
    ) {
      continue;
    }
    cases.push({
      localCaseId,
      adoTestCaseId,
      adoTestCaseUrl,
      parentWorkItemId,
      publishedAt,
    });
  }
  return cases;
}

function buildTestCaseStepsXml(
  steps: Array<string | { action: string; expected?: string }>,
): string {
  if (steps.length === 0) return '';
  const stepElements = steps.map((step, index) => {
    const action = typeof step === 'string' ? step : step.action;
    const expected = typeof step === 'string' ? '' : (step.expected ?? '');
    return `<step id="${index + 1}" type="ActionStep"><parameterizedString isformatted="true">${escapeXml(action)}</parameterizedString><parameterizedString isformatted="true">${escapeXml(expected)}</parameterizedString></step>`;
  });
  return `<steps id="0" last="${steps.length}">${stepElements.join('')}</steps>`;
}

async function readOutputTestCases(threadId: string): Promise<unknown | null> {
  const file = await findOutputFile(threadId, /\.test-cases\.json$/i);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

async function readOutputTestCasesMd(threadId: string): Promise<string | null> {
  const file = await findOutputFile(threadId, /\.test-cases\.md$/i);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

async function findOutputFile(threadId: string, pattern: RegExp): Promise<string | null> {
  const workspaceDir = await resolveWorkspaceDir(threadId);
  if (!workspaceDir) return null;
  const outputDir = path.join(workspaceDir, '.ai-pilot', 'output');
  return findFirstFile(outputDir, pattern) ?? findFirstFile(workspaceDir, pattern);
}

async function resolveWorkspaceDir(threadId: string): Promise<string | null> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { workspaceDir: true },
  });
  return row?.workspaceDir ?? null;
}

async function cleanupWorkspace(
  threadId: string,
  workspaceDirOverride?: string,
): Promise<void> {
  try {
    const workspaceDir = workspaceDirOverride ?? await resolveWorkspaceDir(threadId);
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // Workspace cleanup is best-effort after the suite row is updated.
  }
}

function findFirstFile(dir: string, pattern: RegExp): string | null {
  const matches = findAllFiles(dir, pattern);
  return matches.length > 0 ? matches[0] : null;
}

function findAllFiles(dir: string, pattern: RegExp): string[] {
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
        results.push(...findAllFiles(path.join(dir, entry.name), pattern));
      }
    }
    results.sort();
    return results;
  } catch {
    return [];
  }
}

function sanitizeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'ado-work-item';
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function plainText(value: string): string {
  return stripHtml(value).replace(/\s+/g, ' ').trim();
}

function cleanCriterionLine(line: string): string {
  return line.replace(/^\d+[.)]\s+/, '').replace(/^[-*]\s+/, '').trim();
}

function nonEmpty(value: string, fallback: string): string {
  const text = value.trim();
  return text.length > 0 ? text : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
