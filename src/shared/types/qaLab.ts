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

export interface QaLabWorkItemTestCases {
  workItemId: number;
  suites: QaLabSuite[];
  sources: QaLabSource[];
  totalCases: number;
}

export interface QaLabGenerateRequest {
  /** Model override for this run; falls back to the project skill config default. */
  model?: string;
  /** Effort override for this run. */
  effort?: string;
}
