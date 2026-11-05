import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads, qaAdoTestSuites } from '../db/schema';
import type { EffortLevel } from '../../shared/types/effort';
import type { TestCaseCoverageSummary } from '../../shared/types/interview';
import type {
  QaAdoGenerationContext,
  QaAdoGenerationItem,
  QaAdoPlacement,
  QaAdoPlacementLinkTo,
  QaAdoPlacementLinkType,
  QaAdoSuiteSelection,
  QaAdoTestPlanOption,
  QaLabGenerationCandidates,
  QaLabPublishedCase,
} from '../../shared/types/qaLab';
import { DEVELOPER_ONLY_AUTOMATION_TIERS } from '../../shared/types/qaLab';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
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
import { readRemoteBranchTip } from './repoCacheService';
import {
  propagatePipelineGrounding,
  runGroundingService,
} from './runGroundingService';

export const ADO_TEST_SUITE_WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 360;
const QA_LAB_SCOPE_FILE = 'qa-lab-scope.json';
const NOT_SPECIFIED = 'Not specified on the Azure DevOps work item';

const activeAdoTestSuiteWatchers = new Map<string, ReturnType<typeof setInterval>>();

export type QaAdoPublishedCase = QaLabPublishedCase;

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
  /** Lets the skill propose real Test Plan and suite names. */
  listStaticTestPlanSuites?(): Promise<QaAdoTestPlanOption[]>;
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
  /** ADO ids of the PBIs/Bugs to generate. Omit for every PBI/Bug beneath the root. */
  targetIds?: number[];
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
  userStory: { persona: string; iWant: string; soThat: string };
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
  personas: Array<{ name: string; type: 'Internal' | 'Admin'; description: string }>;
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
      affectedPersonas: string[];
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
    linkType?: QaAdoPlacementLinkType;
    areaPath?: string;
    iterationPath?: string;
    tags?: string[];
  }): Promise<{ id: number; url: string }>;
  addTestCasesToSuite?(planId: number, suiteId: number, testCaseIds: number[]): Promise<void>;
}

export interface PublishAdoTestCasesOptions {
  /** Local case ids to publish. Omit to publish every unpublished case. */
  localCaseIds?: string[];
  /** Test Plan suites QA confirmed, keyed by local case id. */
  selections?: Record<string, QaAdoSuiteSelection>;
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
  /** A unit or integration check, which is not a QA Test Case. */
  developerOnly: boolean;
  parentWorkItemId: number;
  placement: QaAdoPlacement;
  placementError: string | null;
}

const PLACEMENT_LINK_TO: readonly QaAdoPlacementLinkTo[] = ['requirement', 'parent', 'root'];
const PLACEMENT_LINK_TYPES: readonly QaAdoPlacementLinkType[] = ['tested-by', 'hierarchy', 'related'];
const MAX_PLACEMENT_TAGS = 20;
const MAX_TAG_LENGTH = 100;
const MAX_CLASSIFICATION_PATH_LENGTH = 256;
const TEST_PLANS_FILE = '.ai-pilot/test-plans.md';

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

  const rootUserTypes = inferUserTypes(
    [context.root.title, context.root.description, context.root.acceptanceCriteria].join('\n'),
  );
  const pbiItems = targets.map((target) =>
    toSyntheticPbi(target, technicalContext, rootUserTypes[0] ?? DEFAULT_USER_TYPE),
  );
  const tbiItems = technicalContext.map(toSyntheticTbi);
  const userTypes = Array.from(new Set([
    ...rootUserTypes,
    ...targets.flatMap((target) => inferUserTypes(itemText(target))),
  ]));
  if (userTypes.length === 0) userTypes.push(DEFAULT_USER_TYPE);

  return {
    personas: userTypes.map((name) => ({
      name,
      type: /admin/i.test(name) ? 'Admin' : 'Internal',
      description: `${name} as named in the Azure DevOps work items.`,
    })),
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
        affectedPersonas: userTypes,
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

/** Keeps only the chosen PBIs/Bugs. TBIs stay as context for whatever remains. */
export function narrowGenerationTargets(
  context: QaAdoGenerationContext,
  targetIds: number[] | undefined,
): QaAdoGenerationContext {
  if (!targetIds) return context;
  const wanted = new Set(targetIds);
  return { ...context, targets: context.targets.filter((target) => wanted.has(target.id)) };
}

/** PBIs and Bugs beneath the root, for the QA Lab scope picker. */
export async function listAdoGenerationCandidates(
  project: string,
  rootWorkItemId: number,
  ado: AdoQaContextReader = new AzureDevOpsService(project),
): Promise<QaLabGenerationCandidates | null> {
  const context = await ado.getQaTestGenerationContext(rootWorkItemId);
  if (!context) return null;
  return {
    rootWorkItemId,
    items: context.targets.map((target) => ({
      id: target.id,
      parentId: target.parentId,
      title: target.title,
      state: target.state,
      workItemType: target.workItemType,
    })),
  };
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
  const fullContext = await reader.getQaTestGenerationContext(input.rootWorkItemId);
  if (!fullContext) return { started: false, reason: 'root-not-found' };
  const context = narrowGenerationTargets(fullContext, input.targetIds);
  if (context.targets.length === 0) return { started: false, reason: 'no-targets' };

  const backlog = buildSyntheticAdoBacklog(context);
  const pbiIds = backlog.epics[0].features[0].items
    .filter((item): item is SyntheticAdoPbiItem => item.type === 'PBI')
    .map((item) => item.id);
  const slug = sanitizeSlug(context.root.title);
  const prdMarkdown = renderSyntheticPrd(context, pbiIds);
  const kickoffMessage = buildKickoffMessage(pbiIds);
  const testPlans = await readTestPlanOptions(reader);
  const freeformContext = renderGenerationContext({
    project,
    rootWorkItemId: input.rootWorkItemId,
    slug,
    prdMarkdown,
    backlog,
    testPlans,
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
  writeTestPlanFile(thread.workspaceDir, testPlans);
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

  // Repository preparation can outlast the App Service request. The suite row
  // is already saved, so the page can poll while the worker starts.
  void dispatchAdoTestSuite({
    suiteId: inserted.id,
    threadId: thread.id,
    workspaceDir: thread.workspaceDir,
    userId,
    project,
    repository: qaLabRepository(skillConfig),
    sourceThreadId: input.sourceThreadId,
    kickoffMessage,
  });
  console.log(
    `[adoTestSuite] Queued generation — suiteId=${inserted.id} rootWorkItemId=${context.root.id} threadId=${thread.id}`,
  );
  return { started: true, suiteId: inserted.id, threadId: thread.id };
}

async function dispatchAdoTestSuite(input: {
  suiteId: string;
  threadId: string;
  workspaceDir: string;
  userId: string;
  project: string;
  repository: QaLabRepository;
  sourceThreadId?: string;
  kickoffMessage: string;
}): Promise<void> {
  const dispatched = await dispatchQaLabRun({
    ...input,
    logLabel: `suiteId=${input.suiteId}`,
    onPreparationFailure: () => markAdoTestSuiteFailed(input.suiteId, input.threadId, input.workspaceDir),
  });
  if (dispatched) startAdoTestSuiteWatcher(input.suiteId, input.threadId);
}

/**
 * Starts the hidden agent turn for a QA Lab thread. Returns false when routing
 * failed; `onPreparationFailure` has already run by then.
 */
export type QaLabRepository = Readonly<{
  provider: SkillProvider;
  repo: string;
  branch: string;
}>;

export function qaLabRepository(skillConfig: {
  skillRepo: string;
  skillBranch?: string | null;
  skillProvider?: SkillProvider | null;
}): QaLabRepository {
  return {
    provider: skillConfig.skillProvider ?? 'ado',
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch ?? 'main',
  };
}

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

function findTargetGrounding(groundings: RunGrounding[]): RunGrounding | undefined {
  return groundings.find((grounding) =>
    grounding.repoRole === 'target'
    && grounding.isActive
    && COMMIT_SHA_RE.test(grounding.groundedSha.trim()));
}

/**
 * Work-item runs have no source thread to copy a commit from, and the App
 * Service clone may still be preparing. The V2 worker reads through repo-read
 * at a pinned commit, so pin the branch tip when nothing else did.
 */
async function pinBranchTipWhenUngrounded(
  run: RunRef,
  repository: QaLabRepository,
  logLabel: string,
): Promise<RunGrounding | undefined> {
  const existing = findTargetGrounding(await runGroundingService.getGroundings(run));
  if (existing) return existing;

  const sha = await readRemoteBranchTip({
    provider: repository.provider,
    project: run.project,
    repo: repository.repo,
    branch: repository.branch,
  }).catch((error: unknown) => {
    console.warn(
      `[adoTestSuite] Branch tip lookup failed (${logLabel}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  });
  if (!sha) return undefined;

  await runGroundingService.activateGroundings({
    run,
    target: {
      provider: repository.provider === 'ado' ? 'azure_devops' : 'github',
      repository: repository.provider === 'github'
        ? repository.repo.split('/').pop() || repository.repo
        : repository.repo,
      branch: repository.branch,
      groundedSha: sha,
    },
  });
  console.log(`[adoTestSuite] Pinned ${repository.repo}@${repository.branch} to ${sha.slice(0, 12)} (${logLabel})`);
  return findTargetGrounding(await runGroundingService.getGroundings(run));
}

export async function dispatchQaLabRun(input: {
  threadId: string;
  userId: string;
  project: string;
  repository: QaLabRepository;
  sourceThreadId?: string;
  kickoffMessage: string;
  logLabel: string;
  onPreparationFailure: () => Promise<void>;
}): Promise<boolean> {
  const destinationRun: RunRef = {
    runType: 'chat',
    runId: input.threadId,
    project: input.project,
  };
  const reportPreparationFailure = async (): Promise<void> => {
    await runGroundingService.persistThenMarkTerminalInactive(
      destinationRun,
      input.onPreparationFailure,
    );
  };

  try {
    await routeBackgroundWorkflow({
      userId: input.userId,
      workflowClass: 'test-cases',
      destinationRun,
      threadId: input.threadId,
      prepareWorker: async () => {
        if (input.sourceThreadId) {
          try {
            await propagatePipelineGrounding(
              { runType: 'chat', runId: input.sourceThreadId, project: input.project },
              destinationRun,
              input.userId,
              { deferMaterialization: true },
            );
          } catch {
            console.warn(
              `[adoTestSuite] Grounding propagation unavailable (${input.logLabel})`,
            );
          }
        }
        const prepared = await prepareBackgroundWorkflowTurn(input.threadId, input.kickoffMessage);
        const targetGrounding = await pinBranchTipWhenUngrounded(
          destinationRun,
          input.repository,
          input.logLabel,
        );
        return { ...prepared, targetGrounding };
      },
      runInProcess: () => sendMessage(
        input.threadId,
        input.kickoffMessage,
        undefined,
        [],
        { hidden: true },
      ),
      reportRecoverablePreparationFailure: reportPreparationFailure,
    });
  } catch (error) {
    console.error(
      `[adoTestSuite] Routing failed (${input.logLabel})`,
      error,
    );
    await reportPreparationFailure();
    return false;
  }
  return true;
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
  const requested = options.localCaseIds
    ?? cases.filter((testCase) => !testCase.developerOnly).map((testCase) => testCase.localCaseId);
  const writer = await resolveTestCaseWriter(row.project, row.sourceSnapshot, options);
  const context = generationContextFrom(row.sourceSnapshot);
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
    const selection = options.selections?.[localCaseId];
    if (selection !== undefined && !isValidSelection(selection)) {
      failures.push({ localCaseId, message: 'The selected Test Plan suite is not valid' });
      continue;
    }
    const existing = stored.find((item) => item.localCaseId === localCaseId);
    if (existing) {
      if (!existing.suiteError || !selection) {
        skippedLocalCaseIds.push(localCaseId);
        continue;
      }
      const retried = await addToSuite(writer, existing, selection);
      await savePublishedCase(suiteId, retried);
      if (retried.suiteError) {
        failures.push({ localCaseId, message: suiteFailureMessage(retried) });
      } else {
        published.push(retried);
      }
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
    if (testCase.developerOnly) {
      failures.push({
        localCaseId,
        message: 'Unit and integration checks are not published as Test Cases',
      });
      continue;
    }

    if (testCase.placementError) {
      failures.push({ localCaseId, message: testCase.placementError });
      continue;
    }
    const { placement } = testCase;
    const outsideProject = [placement.areaPath, placement.iterationPath]
      .find((value) => value !== undefined && !isUnderProject(value, row.project));
    if (outsideProject !== undefined) {
      failures.push({
        localCaseId,
        message: `Placement path "${outsideProject}" is not under the ${row.project} project`,
      });
      continue;
    }
    const linkTarget = resolveLinkTarget(testCase, context);
    if ('error' in linkTarget) {
      failures.push({ localCaseId, message: linkTarget.error });
      continue;
    }
    if (!selection && placement.requireSuite) {
      failures.push({
        localCaseId,
        message: 'Confirm a Test Plan and suite for this case before publishing',
      });
      continue;
    }
    if (selection && !writer.addTestCasesToSuite) {
      failures.push({
        localCaseId,
        message: 'This Azure DevOps client cannot add cases to Test Plan suites',
      });
      continue;
    }

    try {
      const created = await writer.createTestCaseWorkItem({
        title: testCase.title,
        stepsHtml: buildTestCaseStepsXml(testCase.steps),
        parentId: linkTarget.id,
        linkType: placement.linkType ?? 'tested-by',
        ...(placement.areaPath ? { areaPath: placement.areaPath } : {}),
        ...(placement.iterationPath ? { iterationPath: placement.iterationPath } : {}),
        ...(placement.tags?.length ? { tags: placement.tags } : {}),
        ...(options.assignedTo ? { assignedTo: options.assignedTo } : {}),
      });
      const createdCase: QaAdoPublishedCase = {
        localCaseId,
        adoTestCaseId: created.id,
        adoTestCaseUrl: created.url,
        parentWorkItemId: linkTarget.id,
        publishedAt: new Date().toISOString(),
      };
      // Save the created Test Case before the suite call so a suite failure can
      // be retried without creating a second Test Case.
      await savePublishedCase(suiteId, createdCase);
      const entry = selection ? await addToSuite(writer, createdCase, selection) : createdCase;
      if (selection) await savePublishedCase(suiteId, entry);
      published.push(entry);
      if (entry.suiteError) failures.push({ localCaseId, message: suiteFailureMessage(entry) });
    } catch (error) {
      failures.push({
        localCaseId,
        message: error instanceof Error ? error.message : 'Test case publish failed',
      });
    }
  }

  return { published, skippedLocalCaseIds, failures };
}

function isValidSelection(selection: QaAdoSuiteSelection): boolean {
  return Number.isSafeInteger(selection?.planId) && selection.planId > 0
    && Number.isSafeInteger(selection?.suiteId) && selection.suiteId > 0;
}

async function addToSuite(
  writer: AdoTestCaseWriter,
  entry: QaAdoPublishedCase,
  selection: QaAdoSuiteSelection,
): Promise<QaAdoPublishedCase> {
  const { suiteError: _previousError, ...rest } = entry;
  const placed = { ...rest, testPlanId: selection.planId, testSuiteId: selection.suiteId };
  if (!writer.addTestCasesToSuite) {
    return { ...placed, suiteError: 'This Azure DevOps client cannot add cases to Test Plan suites' };
  }
  try {
    await writer.addTestCasesToSuite(selection.planId, selection.suiteId, [entry.adoTestCaseId]);
    return placed;
  } catch (error) {
    return {
      ...placed,
      suiteError: error instanceof Error ? error.message : 'Adding the case to the suite failed',
    };
  }
}

function suiteFailureMessage(entry: QaAdoPublishedCase): string {
  return `Created Test Case ${entry.adoTestCaseId} but could not add it to the suite: ${entry.suiteError}`;
}

/** Upserts one published case. A different Test Case already saved for the id wins. */
async function savePublishedCase(suiteId: string, entry: QaAdoPublishedCase): Promise<void> {
  const current = publishedCasesFrom((await loadSuite(suiteId))?.publishedCases);
  const index = current.findIndex((item) => item.localCaseId === entry.localCaseId);
  if (index >= 0 && current[index].adoTestCaseId !== entry.adoTestCaseId) return;
  if (index >= 0) current[index] = entry;
  else current.push(entry);
  await db
    .update(qaAdoTestSuites)
    .set({ publishedCases: current, updatedAt: new Date().toISOString() })
    .where(eq(qaAdoTestSuites.id, suiteId));
}

/** True when the project's skill output requires a confirmed suite for every case. */
export function suiteRequiredByOutput(testCasesJson: unknown): boolean {
  return parsePlacement(asRecord(testCasesJson)?.placement).placement.requireSuite === true;
}

/** A request the suite's current state cannot accept, such as deleting a published case. */
export class AdoTestSuiteConflictError extends Error {}

/**
 * Removes generated cases from the suite before they reach Azure DevOps. A case
 * already published stays, because its Test Case work item lives in ADO.
 */
export async function deleteAdoTestCases(
  suiteId: string,
  localCaseIds: string[],
): Promise<{ deletedLocalCaseIds: string[] }> {
  const row = await loadSuite(suiteId);
  if (!row) throw new Error(`ADO test suite ${suiteId} was not found`);
  if (row.status !== 'ready') {
    throw new AdoTestSuiteConflictError('Test cases can be deleted only after generation finishes');
  }
  const wanted = new Set(localCaseIds);
  const published = publishedCasesFrom(row.publishedCases)
    .filter((entry) => wanted.has(entry.localCaseId))
    .map((entry) => entry.localCaseId);
  if (published.length > 0) {
    throw new AdoTestSuiteConflictError(
      `Already published to Azure DevOps, delete there instead: ${published.join(', ')}`,
    );
  }

  const root = asRecord(row.testCasesJson);
  const suites = Array.isArray(root?.suites) ? root.suites : [];
  const deleted: string[] = [];
  const nextSuites = suites.map((suiteValue) => {
    const suite = asRecord(suiteValue);
    if (!suite) return suiteValue;
    const key = (['testCases', 'test_cases', 'cases'] as const).find((name) => Array.isArray(suite[name]));
    if (!key) return suiteValue;
    const parentWorkItemId = parentIdFromSuite(suite);
    const pbiId = stringFrom(suite.pbiId)
      ?? stringFrom(suite.pbi_id)
      ?? (parentWorkItemId === null ? '' : adoBacklogPbiId(parentWorkItemId));
    const kept = (suite[key] as unknown[]).filter((value, index) => {
      const record = asRecord(value);
      const id = record ? localCaseIdOf(record, pbiId, index) : null;
      if (id === null || !wanted.has(id)) return true;
      deleted.push(id);
      return false;
    });
    if (kept.length === (suite[key] as unknown[]).length) return suiteValue;
    return {
      ...suite,
      [key]: kept,
      ...(typeof suite.testCaseCount === 'number' ? { testCaseCount: kept.length } : {}),
    };
  });
  if (deleted.length === 0) return { deletedLocalCaseIds: [] };

  const testCasesJson = { ...root, suites: nextSuites };
  await db
    .update(qaAdoTestSuites)
    .set({
      testCasesJson,
      coverageSummary: summarizeCoverage(testCasesJson),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(qaAdoTestSuites.id, suiteId), eq(qaAdoTestSuites.status, 'ready')));
  return { deletedLocalCaseIds: deleted };
}

export interface AdoSuiteCaseMatch {
  testCase: Record<string, unknown>;
  pbiId: string;
  parentWorkItemId: number | null;
}

export function findAdoSuiteCase(testCasesJson: unknown, localCaseId: string): AdoSuiteCaseMatch | null {
  let match: AdoSuiteCaseMatch | null = null;
  mapSuiteCases(testCasesJson, (testCase, id, pbiId, parentWorkItemId) => {
    if (!match && id === localCaseId) match = { testCase, pbiId, parentWorkItemId };
    return testCase;
  });
  return match;
}

export function listAdoSuiteCases(testCasesJson: unknown): Array<AdoSuiteCaseMatch & { localCaseId: string }> {
  const cases: Array<AdoSuiteCaseMatch & { localCaseId: string }> = [];
  mapSuiteCases(testCasesJson, (testCase, localCaseId, pbiId, parentWorkItemId) => {
    cases.push({ testCase, localCaseId, pbiId, parentWorkItemId });
    return testCase;
  });
  return cases;
}

/** Swaps one case for `next`. Returns null when the case is not in the output. */
export function replaceAdoSuiteCase(
  testCasesJson: unknown,
  localCaseId: string,
  next: Record<string, unknown>,
): Record<string, unknown> | null {
  let replaced = false;
  const result = mapSuiteCases(testCasesJson, (testCase, id) => {
    if (replaced || id !== localCaseId) return testCase;
    replaced = true;
    return next;
  });
  return replaced ? result : null;
}

/**
 * Appends `testCase` to the suite for one work item, given as `PBI-123` or `123`,
 * under a new id. Returns null when no suite covers that work item.
 */
export function appendAdoSuiteCase(
  testCasesJson: unknown,
  workItemRef: string,
  testCase: Record<string, unknown>,
): { testCasesJson: Record<string, unknown>; localCaseId: string } | null {
  const taken = new Set<string>();
  mapSuiteCases(testCasesJson, (record, id) => {
    taken.add(id);
    return record;
  });
  const wanted = workItemRef.trim().replace(/^PBI-/i, '');
  const root = asRecord(testCasesJson) ?? {};
  const suites = Array.isArray(root.suites) ? root.suites : [];
  let localCaseId: string | null = null;
  const nextSuites = suites.map((suiteValue) => {
    const suite = asRecord(suiteValue);
    if (localCaseId !== null || !suite) return suiteValue;
    const parentWorkItemId = parentIdFromSuite(suite);
    const pbiId = stringFrom(suite.pbiId)
      ?? stringFrom(suite.pbi_id)
      ?? (parentWorkItemId === null ? '' : adoBacklogPbiId(parentWorkItemId));
    if (String(parentWorkItemId) !== wanted && pbiId.replace(/^PBI-/i, '') !== wanted) return suiteValue;
    const key = (['testCases', 'test_cases', 'cases'] as const).find((name) => Array.isArray(suite[name])) ?? 'testCases';
    const cases = Array.isArray(suite[key]) ? suite[key] as unknown[] : [];
    let next = cases.length + 1;
    while (taken.has(`${pbiId}-${next}`)) next += 1;
    localCaseId = `${pbiId}-${next}`;
    const nextCases = [...cases, { ...testCase, id: localCaseId }];
    return {
      ...suite,
      [key]: nextCases,
      ...(typeof suite.testCaseCount === 'number' ? { testCaseCount: nextCases.length } : {}),
    };
  });
  return localCaseId === null ? null : { testCasesJson: { ...root, suites: nextSuites }, localCaseId };
}

function mapSuiteCases(
  testCasesJson: unknown,
  map: (
    testCase: Record<string, unknown>,
    localCaseId: string,
    pbiId: string,
    parentWorkItemId: number | null,
  ) => Record<string, unknown>,
): Record<string, unknown> {
  const root = asRecord(testCasesJson) ?? {};
  const suites = Array.isArray(root.suites) ? root.suites : [];
  const nextSuites = suites.map((suiteValue) => {
    const suite = asRecord(suiteValue);
    if (!suite) return suiteValue;
    const key = (['testCases', 'test_cases', 'cases'] as const).find((name) => Array.isArray(suite[name]));
    if (!key) return suiteValue;
    const parentWorkItemId = parentIdFromSuite(suite);
    const pbiId = stringFrom(suite.pbiId)
      ?? stringFrom(suite.pbi_id)
      ?? (parentWorkItemId === null ? '' : adoBacklogPbiId(parentWorkItemId));
    const cases = (suite[key] as unknown[]).map((value, index) => {
      const record = asRecord(value);
      return record ? map(record, localCaseIdOf(record, pbiId, index), pbiId, parentWorkItemId) : value;
    });
    return { ...suite, [key]: cases };
  });
  return { ...root, suites: nextSuites };
}
/**
 * Post-run hook for agent output, including V2 worker harvests whose files
 * live in a temporary workspace instead of the thread workspace.
 * Returns true when the thread belongs to an ADO-native suite.
 */
export async function syncAdoTestSuiteRunOutput(
  chatThreadId: string,
  workspaceDir?: string,
  detail?: string,
): Promise<boolean> {
  const row = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.chatThreadId, chatThreadId),
    columns: { id: true, status: true },
  });
  if (!row) return false;
  if (row.status !== 'generating') return true;

  if (await syncAdoTestSuiteOutput(row.id, chatThreadId, workspaceDir)) {
    stopAdoTestSuiteWatcher(row.id);
    return true;
  }
  const reason = detail?.trim().slice(0, 500);
  console.warn(
    `[adoTestSuite] Agent run produced no test-case output (suiteId=${row.id})`
      + (reason ? `: ${reason}` : ''),
  );
  stopAdoTestSuiteWatcher(row.id);
  await markAdoTestSuiteFailed(row.id, chatThreadId);
  return true;
}

export async function syncAdoTestSuiteOutput(
  suiteId: string,
  chatThreadId: string,
  workspaceDirOverride?: string,
): Promise<boolean> {
  const testCasesJson = await readOutputTestCases(chatThreadId, workspaceDirOverride);
  if (testCasesJson === null) return false;

  const row = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, suiteId),
    columns: { chatThreadId: true, status: true },
  });
  if (!row || row.chatThreadId !== chatThreadId || row.status !== 'generating') {
    await cleanupWorkspace(chatThreadId);
    return false;
  }

  const testCasesMd = await readOutputTestCasesMd(chatThreadId, workspaceDirOverride);
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

const DEFAULT_USER_TYPE = 'User';

/** Phrases like "external user" or "internal users" that name a user type. */
const USER_TYPE_PHRASE = /\b((?:external|internal|guest|anonymous|logged[- ]in|authenticated|unauthenticated|admin|super admin)\s+users?)\b/gi;
/** "As a recruiter, I want…" / "As an external user I can…" */
const AS_A_PHRASE = /\bas an?\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3}?)\s*(?:,|\bi\b|\bwho\b|\bwith\b|\bi'd\b)/gi;

/** "As a result," and similar phrases that are not user types. */
const NOT_USER_TYPES = new Set([
  'result', 'example', 'rule', 'default', 'whole', 'minimum', 'maximum',
  'fallback', 'workaround', 'reminder', 'side effect', 'precaution', 'consequence',
]);

function toTitleCase(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\busers\b/i, 'user')
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function itemText(item: QaAdoGenerationItem): string {
  return [item.title, item.description, item.acceptanceCriteria, item.reproSteps].join('\n');
}

/** User types named in work item text, in first-seen order. */
export function inferUserTypes(raw: string): string[] {
  const text = plainText(raw);
  const found: Array<{ index: number; name: string }> = [];
  for (const pattern of [USER_TYPE_PHRASE, AS_A_PHRASE]) {
    for (const match of text.matchAll(pattern)) {
      if (NOT_USER_TYPES.has(match[1].trim().toLowerCase())) continue;
      found.push({ index: match.index ?? 0, name: toTitleCase(match[1]) });
    }
  }
  return Array.from(new Set(
    found.sort((left, right) => left.index - right.index).map((entry) => entry.name),
  )).slice(0, 8);
}

function toSyntheticPbi(
  target: QaAdoGenerationItem,
  technicalContext: QaAdoGenerationItem[],
  fallbackUserType: string,
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
      persona: inferUserTypes(itemText(target))[0] ?? fallbackUserType,
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
  testPlans: QaAdoTestPlanOption[];
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
    `2. Patch \`.ai-pilot/output/${input.slug}.backlog.json\` with \`testCaseCount\` for each PBI`,
    '',
    `Do NOT write \`${input.slug}.test-cases.md\`. Apex shows the cases from the JSON. Write the JSON`,
    'once, complete, in a single write; do not reread or rewrite it afterwards.',
    '',
    '## User types',
    '',
    'This backlog comes from Azure DevOps, not from an Apex PRD. Its personas are the',
    "product's own user types, read from the work item text. Use them verbatim as each",
    "case's `persona` instead of the Apex persona list. Use `User` only when the work",
    'items name no user type. How to cover a requirement shared by several user types,',
    'and how many cases to write, is set by the skill.',
    '',
    ...renderTestPlanSection(input.testPlans),
    '## Synthetic PRD',
    input.prdMarkdown,
    '',
    '## Backlog JSON',
    '```json',
    JSON.stringify(input.backlog, null, 2),
    '```',
  ].join('\n');
}

export async function readTestPlanOptions(reader: AdoQaContextReader): Promise<QaAdoTestPlanOption[]> {
  if (!reader.listStaticTestPlanSuites) return [];
  try {
    return await reader.listStaticTestPlanSuites();
  } catch (error) {
    console.warn(
      `[adoTestSuite] Test Plans unavailable for generation context: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

export function renderTestPlanSection(testPlans: QaAdoTestPlanOption[]): string[] {
  if (testPlans.length === 0) return [];
  return [
    '## Azure Test Plans',
    '',
    `Every Test Plan and static suite in Azure DevOps is listed in \`${TEST_PLANS_FILE}\`,`,
    'one plan per top-level bullet with its suite paths beneath. When this project\'s skill',
    'files cases in Test Plans, search that file for the module and sub-module, then copy',
    '`placement.testPlan` and `placement.testSuite` from it exactly. QA confirms the',
    'placement in Apex before anything is published.',
    '',
  ];
}

/** Writes the full Test Plan list the kickoff context points at; no-op when there are none. */
export function writeTestPlanFile(workspaceDir: string, testPlans: QaAdoTestPlanOption[]): void {
  if (testPlans.length === 0) return;
  const lines = ['# Azure Test Plans', ''];
  for (const plan of testPlans) {
    lines.push(`- ${plan.name}`);
    for (const suite of plan.suites) {
      if (suite.path) lines.push(`  - ${suite.path}`);
    }
  }
  fs.mkdirSync(path.join(workspaceDir, '.ai-pilot'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, TEST_PLANS_FILE), `${lines.join('\n')}\n`, 'utf-8');
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
  const defaultPlacement = parsePlacement(root.placement);
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
      const testCase = toPublishableCase(value, pbiId, parentWorkItemId, index, defaultPlacement);
      if (!testCase || seen.has(testCase.localCaseId)) return;
      seen.add(testCase.localCaseId);
      found.push(testCase);
    });
  }

  return found;
}

export function parentIdFromSuite(suite: Record<string, unknown>): number | null {
  const explicit = numberFrom(suite.adoWorkItemId) ?? numberFrom(suite.ado_work_item_id);
  if (explicit !== null) return explicit;
  const pbiId = stringFrom(suite.pbiId) ?? stringFrom(suite.pbi_id) ?? '';
  const match = /^PBI-(\d+)$/i.exec(pbiId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export function localCaseIdOf(record: Record<string, unknown>, pbiId: string, index: number): string {
  return stringFrom(record.id)
    ?? stringFrom(record.testCaseId)
    ?? stringFrom(record.test_case_id)
    ?? stringFrom(record.caseId)
    ?? `${pbiId}-${index + 1}`;
}

function toPublishableCase(
  value: unknown,
  pbiId: string,
  parentWorkItemId: number,
  index: number,
  defaultPlacement: ParsedPlacement,
): PublishableCase | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = stringFrom(record.title) ?? stringFrom(record.name);
  if (!title) return null;
  const localCaseId = localCaseIdOf(record, pbiId, index);
  const casePlacement = parsePlacement(record.placement);
  const automationTier = stringFrom(asRecord(record.automation)?.recommendedTier)
    ?? stringFrom(record.automationTier);
  return {
    localCaseId,
    title,
    steps: stepsFrom(record.steps),
    developerOnly: automationTier !== null && DEVELOPER_ONLY_AUTOMATION_TIERS.includes(automationTier),
    parentWorkItemId,
    placement: mergePlacements(defaultPlacement.placement, casePlacement.placement),
    placementError: defaultPlacement.error ?? casePlacement.error,
  };
}

interface ParsedPlacement {
  placement: QaAdoPlacement;
  error: string | null;
}

/** Reads the skill's placement block. An invalid value becomes a per-case publish failure. */
function parsePlacement(value: unknown): ParsedPlacement {
  if (value === undefined || value === null) return { placement: {}, error: null };
  const record = asRecord(value);
  if (!record) return { placement: {}, error: 'placement must be an object' };

  const placement: QaAdoPlacement = {};
  const invalid = (message: string): ParsedPlacement => ({ placement: {}, error: message });

  if (record.linkTo !== undefined) {
    if (!PLACEMENT_LINK_TO.includes(record.linkTo as QaAdoPlacementLinkTo)) {
      return invalid(`placement.linkTo must be one of ${PLACEMENT_LINK_TO.join(', ')}`);
    }
    placement.linkTo = record.linkTo as QaAdoPlacementLinkTo;
  }
  if (record.linkType !== undefined) {
    if (!PLACEMENT_LINK_TYPES.includes(record.linkType as QaAdoPlacementLinkType)) {
      return invalid(`placement.linkType must be one of ${PLACEMENT_LINK_TYPES.join(', ')}`);
    }
    placement.linkType = record.linkType as QaAdoPlacementLinkType;
  }
  for (const key of ['areaPath', 'iterationPath', 'testPlan', 'testSuite'] as const) {
    const raw = record[key];
    if (raw === undefined) continue;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || text.length > MAX_CLASSIFICATION_PATH_LENGTH) {
      return invalid(`placement.${key} must be a non-empty value of at most ${MAX_CLASSIFICATION_PATH_LENGTH} characters`);
    }
    placement[key] = text;
  }
  if (record.requireSuite !== undefined) {
    if (typeof record.requireSuite !== 'boolean') return invalid('placement.requireSuite must be true or false');
    placement.requireSuite = record.requireSuite;
  }
  if (record.tags !== undefined) {
    if (!Array.isArray(record.tags) || record.tags.length > MAX_PLACEMENT_TAGS) {
      return invalid(`placement.tags must be a list of at most ${MAX_PLACEMENT_TAGS} tags`);
    }
    const tags: string[] = [];
    for (const tag of record.tags) {
      const text = typeof tag === 'string' ? tag.trim() : '';
      if (!text || text.length > MAX_TAG_LENGTH || text.includes(';')) {
        return invalid(`placement.tags entries must be non-empty, at most ${MAX_TAG_LENGTH} characters, and contain no ";"`);
      }
      tags.push(text);
    }
    placement.tags = tags;
  }
  return { placement, error: null };
}

function mergePlacements(base: QaAdoPlacement, override: QaAdoPlacement): QaAdoPlacement {
  const tags = Array.from(new Set([...(base.tags ?? []), ...(override.tags ?? [])]));
  return {
    ...base,
    ...override,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function isUnderProject(classificationPath: string, project: string): boolean {
  const normalized = classificationPath.toLowerCase();
  const prefix = project.toLowerCase();
  return normalized === prefix || normalized.startsWith(`${prefix}\\`);
}

/** Resolves the work item a case links to, using only ids from the captured ADO hierarchy. */
function resolveLinkTarget(
  testCase: PublishableCase,
  context: QaAdoGenerationContext,
): { id: number } | { error: string } {
  const linkTo = testCase.placement.linkTo ?? 'requirement';
  switch (linkTo) {
    case 'requirement':
      return { id: testCase.parentWorkItemId };
    case 'root':
      return context.root.id > 0
        ? { id: context.root.id }
        : { error: 'The suite has no root work item to link to' };
    case 'parent': {
      const owner = context.targets.find((item) => item.id === testCase.parentWorkItemId)
        ?? (context.root.id === testCase.parentWorkItemId ? context.root : null);
      return owner?.parentId
        ? { id: owner.parentId }
        : { error: `Work item ${testCase.parentWorkItemId} has no parent to link to` };
    }
    default: {
      const unhandled: never = linkTo;
      throw new Error(`Unknown placement.linkTo: ${String(unhandled)}`);
    }
  }
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

export function summarizeCoverage(testCasesJson: unknown): TestCaseCoverageSummary | null {
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

export function publishedCasesFrom(value: unknown): QaAdoPublishedCase[] {
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
    const testPlanId = numberFrom(record?.testPlanId);
    const testSuiteId = numberFrom(record?.testSuiteId);
    const suiteError = stringFrom(record?.suiteError);
    cases.push({
      localCaseId,
      adoTestCaseId,
      adoTestCaseUrl,
      parentWorkItemId,
      publishedAt,
      ...(testPlanId !== null ? { testPlanId } : {}),
      ...(testSuiteId !== null ? { testSuiteId } : {}),
      ...(suiteError ? { suiteError } : {}),
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

async function readOutputTestCases(
  threadId: string,
  workspaceDirOverride?: string,
): Promise<unknown | null> {
  const file = await findOutputFile(threadId, /\.test-cases\.json$/i, workspaceDirOverride);
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
  } catch (error) {
    console.warn(
      `[adoTestSuite] Could not parse ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function readOutputTestCasesMd(
  threadId: string,
  workspaceDirOverride?: string,
): Promise<string | null> {
  const file = await findOutputFile(threadId, /\.test-cases\.md$/i, workspaceDirOverride);
  return file ? fs.readFileSync(file, 'utf-8') : null;
}

export async function findOutputFile(
  threadId: string,
  pattern: RegExp,
  workspaceDirOverride?: string,
): Promise<string | null> {
  const workspaceDir = workspaceDirOverride ?? await resolveWorkspaceDir(threadId);
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

export async function cleanupWorkspace(
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

export function sanitizeSlug(input: string): string {
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
