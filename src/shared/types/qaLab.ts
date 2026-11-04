import type { TestCaseCoverageSummary, TestCaseStatus } from './interview';

/** Automation tiers developers own. QA Lab hides them and never publishes them as Test Cases. */
export const DEVELOPER_ONLY_AUTOMATION_TIERS: readonly string[] = ['unit', 'integration'];

/** Level of the backlog node whose ADO work item ID matched the lookup. */
export type QaLabMatchLevel = 'pbi' | 'feature' | 'epic';

export interface QaLabTestCaseStep {
  order: number;
  action: string;
  expected: string;
}

/**
 * A single generated test case, flattened from the create-test-case skill output
 * into the shape the QA Lab UI renders.
 */
export interface QaLabTestCase {
  id: string;
  title: string;
  type?: string;
  tier?: string;
  priority?: string;
  persona?: string;
  preconditions: string[];
  testData: Record<string, string>;
  steps: QaLabTestCaseStep[];
  expectedResult?: string;
  automationTier?: string;
  automationCandidate?: boolean;
  automationRationale?: string;
  featureFlag?: string | null;
  featureFlagState?: string | null;
  /** Zero-based index into the parent PBI's acceptance criteria. */
  acceptanceCriteriaIndex?: number | null;
  businessRules: string[];
  pbiId: string;
  /** Test Plan name the skill proposed for this case. */
  proposedTestPlan?: string;
  /** Static suite path the skill proposed, `Suite > Child`. */
  proposedTestSuite?: string;
  /** One line from the skill on why it chose that plan and suite. */
  placementReason?: string;
  /** Set when an Azure DevOps case already covers this scenario. */
  existing?: QaLabExistingCase;
}

export interface QaLabSuite {
  /** Backlog-local PBI identifier, e.g. `PBI-001`. */
  pbiId: string;
  pbiTitle: string;
  featureTitle?: string;
  epicTitle?: string;
  featureFlag?: string | null;
  /** ADO work item ID of the PBI itself, when the backlog has been pushed. */
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
  testCases: QaLabTestCase[];
}

/** Provenance for a set of suites — which PRD and which generation run produced them. */
export interface QaLabSource {
  prdId: string;
  prdTitle: string;
  prdStatus: string;
  /** `test_cases` row ID. */
  testCaseId: string;
  testCaseStatus: TestCaseStatus;
  coverageSummary?: TestCaseCoverageSummary | null;
  generatedAt: string;
  /** Which backlog level matched the requested work item inside this PRD. */
  matchLevel: QaLabMatchLevel;
  /** Title of the matched backlog node. */
  matchedTitle: string;
}

/**
 * Where a selected work item sits in an Apex backlog, even when no suite
 * exists yet. Generation is scoped to these backlog PBI ids.
 */
export interface QaLabGenerationTarget {
  prdId: string;
  prdTitle: string;
  matchLevel: QaLabMatchLevel;
  matchedTitle: string;
  /** Backlog-local ids, e.g. `PBI-001`. */
  pbiIds: string[];
  /** Same PBIs as `pbiIds`, with titles for the scope picker. */
  pbiTargets: QaLabBacklogPbiTarget[];
  /** Latest test-case row for the PRD, when one exists. */
  testCaseStatus?: TestCaseStatus | null;
  /** Agent thread of the latest test-case run, for live progress. */
  testCaseThreadId?: string | null;
}

export interface QaLabBacklogPbiTarget {
  pbiId: string;
  title: string;
}

/** A PBI or Bug that can receive cases when generating from an ADO work item. */
export interface QaLabGenerationCandidate {
  id: number;
  parentId: number | null;
  title: string;
  state: string;
  workItemType: string;
}

export interface QaLabGenerationCandidates {
  rootWorkItemId: number;
  items: QaLabGenerationCandidate[];
}

export interface QaLabPublishedCase {
  localCaseId: string;
  adoTestCaseId: number;
  adoTestCaseUrl: string;
  parentWorkItemId: number;
  publishedAt: string;
  testPlanId?: number;
  testSuiteId?: number;
  /** Set when the Test Case was created but adding it to the suite failed. */
  suiteError?: string;
  /** `updated` when publish applied the suggestion to an existing Test Case. Absent means created. */
  action?: 'updated';
}

/** State for a suite generated directly from an ADO work item. */
export interface QaLabExternalSuite {
  id: string;
  status: TestCaseStatus;
  publishedCases: QaLabPublishedCase[];
  /** The project's skill requires a confirmed Test Plan suite for every case. */
  requireSuite: boolean;
  /** Plans or suites the skill proposed creating. */
  newPlacements: QaLabNewPlacement[];
  /** Agent thread that generates the suite, for live progress. */
  threadId: string | null;
}

export interface QaLabWorkItemTestCases {
  workItemId: number;
  suites: QaLabSuite[];
  sources: QaLabSource[];
  totalCases: number;
  /** Set when the work item is stamped on a PRD backlog. Null otherwise. */
  generation: QaLabGenerationTarget | null;
  /** Set when the latest suite was generated directly from ADO. */
  externalSuite?: QaLabExternalSuite | null;
}

/** A work item shown in the QA Lab picker. Slimmer than the calendar work item. */
export interface QaLabWorkItemSummary {
  id: number;
  title: string;
  state: string;
  workItemType: string;
}

export interface QaLabWorkItemList {
  items: QaLabWorkItemSummary[];
  /** True when Azure DevOps returned its 20,000-item cap and older items were left out. */
  truncated: boolean;
}

export interface QaAdoGenerationItem {
  id: number;
  parentId: number | null;
  workItemType: string;
  title: string;
  state: string;
  areaPath: string;
  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
}

/**
 * Which work item a published Test Case links to. `requirement` is the PBI/Bug
 * that owns the case, `parent` is that item's parent, and `root` is the item
 * QA generated from.
 */
export type QaAdoPlacementLinkTo = 'requirement' | 'parent' | 'root';

export type QaAdoPlacementLinkType = 'tested-by' | 'hierarchy' | 'related';

/**
 * Where the project's create-test-case skill files cases in Azure DevOps. Set
 * at the top of the skill output and optionally per case; per-case values win.
 */
export interface QaAdoPlacement {
  linkTo?: QaAdoPlacementLinkTo;
  linkType?: QaAdoPlacementLinkType;
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
  /** Proposed Azure Test Plan name. QA confirms the plan before publish. */
  testPlan?: string;
  /** Proposed static suite path inside `testPlan`, written `Suite > Child`. */
  testSuite?: string;
  /** Publish refuses cases that have no confirmed Test Plan suite. */
  requireSuite?: boolean;
}

/** A Test Case that already exists in Azure DevOps, with its current steps. */
export interface QaAdoExistingTestCase {
  id: number;
  title: string;
  state: string;
  steps: QaLabTestCaseStep[];
  url: string;
}

/** One line of the static-suite case index the agent compares against. */
export interface QaAdoSuiteCaseIndexEntry {
  id: number;
  title: string;
  planName: string;
  suitePath: string;
}

export interface QaAdoSuiteCaseIndex {
  entries: QaAdoSuiteCaseIndexEntry[];
  /** True when the index stopped at its size cap. */
  truncated: boolean;
}

export type QaLabExistingStatus = 'up-to-date' | 'needs-update';

/** The agent's verdict that a case already exists in Azure DevOps. */
export interface QaLabExistingCase {
  adoTestCaseId: number;
  status: QaLabExistingStatus;
  reason: string;
  source: 'linked' | 'suite';
  /** The case as it is in Azure DevOps now; absent when it could not be read. */
  current?: QaAdoExistingTestCase;
}

/** A static Test Suite a published case can be added to. */
export interface QaAdoTestSuiteOption {
  id: number;
  /** Path below the plan's root suite, `Suite > Child`. Empty for the root suite. */
  path: string;
  /** Set for a requirement suite, which shows every case linked to its PBI by Tested By. */
  requirementId?: number;
}

export interface QaAdoTestPlanOption {
  id: number;
  name: string;
  suites: QaAdoTestSuiteOption[];
}

/** The Test Plan suite QA confirmed for one case. */
export interface QaAdoSuiteSelection {
  planId: number;
  suiteId: number;
  /** A requirement suite: the Tested By link places the case, so publish does not add it. */
  requirement?: boolean;
}

export type QaLabNewPlacementSuiteType = 'static' | 'requirement';

/** A Test Plan or suite the skill proposed because none in Azure DevOps fits. */
export interface QaLabNewPlacement {
  /** Stable id for the proposal within its generated suite. */
  key: string;
  testPlan: string;
  /** Static suite path, `Suite > Child`. Absent for requirement suites, which are named after the PBI. */
  testSuite?: string;
  createPlan: boolean;
  suiteType: QaLabNewPlacementSuiteType;
  reason: string;
}

/** A proposal QA approved, with the names QA may have edited. */
export type QaLabNewPlacementApproval = Omit<QaLabNewPlacement, 'reason'>;

export interface QaLabPublishRequest {
  /** Confirmed suites keyed by local case id. */
  selections?: Record<string, QaAdoSuiteSelection>;
  /** Publish only these cases. Omit to publish every unpublished case. */
  localCaseIds?: string[];
  /** Needs-update cases whose suggestion QA chose to apply to the existing Test Case. */
  updateLocalCaseIds?: string[];
  /** Proposals QA approved; Apex creates them before publishing. */
  newPlacements?: QaLabNewPlacementApproval[];
  /** Local case id to the key of the approved proposal it goes to. */
  newPlacementSelections?: Record<string, string>;
}

export interface QaLabDeleteCasesRequest {
  localCaseIds: string[];
}

export type QaLabCaseCommentStatus = 'open' | 'addressed';

export interface QaLabCaseComment {
  id: string;
  localCaseId: string;
  body: string;
  /** `addressed` once a regeneration used it. */
  status: QaLabCaseCommentStatus;
  authorName: string | null;
  createdAt: string;
}

export type QaLabCaseRegenerationStatus = 'generating' | 'ready' | 'failed' | 'restored';

/** The latest single-case regeneration for one case. */
export type QaLabCaseEditSource = 'comments' | 'assistant';

export interface QaLabCaseRegeneration {
  id: string;
  localCaseId: string;
  status: QaLabCaseRegenerationStatus;
  threadId: string | null;
  error: string | null;
  /** True when the case it replaced can be put back. */
  canRestore: boolean;
  /** comments: rewritten by an agent run from reviewer comments. assistant: edited through Ask Apex. */
  source: QaLabCaseEditSource;
  /** The case as it was before this rewrite; set only while the rewrite is the live version. */
  previousCase: QaLabTestCase | null;
  createdAt: string;
  updatedAt: string;
}

export interface QaLabCaseReview {
  comments: QaLabCaseComment[];
  regenerations: QaLabCaseRegeneration[];
}

export interface QaLabAddCaseCommentRequest {
  body: string;
}

export interface QaLabRegenerateCaseRequest {
  model?: string;
}

export interface QaLabAssistantThreadRequest {
  /** The thread the client used last for this suite; reused when it still fits. */
  threadId?: string | null;
}

/** ADO-native requirement context captured when a QA suite starts. */
export interface QaAdoGenerationContext {
  root: QaAdoGenerationItem;
  /** PBIs and Bugs that directly own generated cases. */
  targets: QaAdoGenerationItem[];
  /** TBIs beneath the root, supplied as implementation context only. */
  technicalContext: QaAdoGenerationItem[];
}

export interface QaLabGenerateRequest {
  /** Model override for this run; falls back to the project skill config default. */
  model?: string;
  /** Effort override for this run. */
  effort?: string;
  /** Backlog PBI ids to generate. Omit to generate the whole PRD. */
  pbiIds?: string[];
  /** ADO ids of the PBIs/Bugs to generate. Omit to generate every PBI/Bug beneath the root. */
  targetIds?: number[];
  matchLevel?: QaLabMatchLevel;
  matchedTitle?: string;
}
