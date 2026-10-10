import type { TestCaseCoverageSummary, TestCaseStatus } from './interview';

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
  /** Latest test-case row for the PRD, when one exists. */
  testCaseStatus?: TestCaseStatus | null;
}

export interface QaLabPublishedCase {
  localCaseId: string;
  adoTestCaseId: number;
  adoTestCaseUrl: string;
  parentWorkItemId: number;
  publishedAt: string;
}

/** State for a suite generated directly from an ADO work item. */
export interface QaLabExternalSuite {
  id: string;
  status: TestCaseStatus;
  publishedCases: QaLabPublishedCase[];
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
  matchLevel?: QaLabMatchLevel;
  matchedTitle?: string;
}
