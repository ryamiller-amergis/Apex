import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { prds } from '../db/schema';
import type {
  QaLabMatchLevel,
  QaLabSource,
  QaLabSuite,
  QaLabTestCase,
  QaLabTestCaseStep,
  QaLabWorkItemTestCases,
} from '../../shared/types/qaLab';
import { getTestCases } from './testCaseService';

/**
 * Resolves generated test cases for an ADO work item.
 *
 * The backlog is the bridge: `stampAdoIds` writes `adoWorkItemId` onto each epic,
 * feature, and item after an ADO push, while test-case suites are keyed by the
 * backlog-local PBI id (`PBI-001`). So a numeric work item resolves to its backlog
 * node, then to that node's PBI id(s), then to the matching suites.
 *
 * Selecting a Feature or Epic returns the suites of every PBI beneath it.
 */

interface BacklogNode {
  id?: string;
  title?: string;
  type?: string;
  adoWorkItemId?: number;
  adoWorkItemUrl?: string;
  features?: BacklogNode[];
  items?: BacklogNode[];
}

interface BacklogRoot {
  epics?: BacklogNode[];
}

/** A backlog node matched by ADO work item id, plus the PBI ids in its subtree. */
interface BacklogMatch {
  level: QaLabMatchLevel;
  title: string;
  /** Backlog-local PBI ids covered by this node. */
  pbiIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asStringList(value: unknown): string[] {
  return asArray(value).flatMap((entry) => {
    const str = asString(entry);
    return str ? [str] : [];
  });
}

/** True when the node is a PBI. Older backlogs omit `type` on PBI rows. */
function isPbiNode(node: BacklogNode): boolean {
  return node.type === undefined || node.type === 'PBI';
}

function collectPbiIds(nodes: BacklogNode[] | undefined): string[] {
  return (nodes ?? []).flatMap((item) =>
    isPbiNode(item) && item.id ? [item.id] : [],
  );
}

/**
 * Walks the backlog tree looking for the node carrying `adoWorkItemId`.
 * Returns the match level and every PBI id beneath it.
 */
export function findBacklogMatch(
  backlogJson: unknown,
  adoWorkItemId: number,
): BacklogMatch | null {
  const root = backlogJson as BacklogRoot | null;
  if (!root?.epics) return null;

  for (const epic of root.epics) {
    if (epic.adoWorkItemId === adoWorkItemId) {
      const pbiIds = (epic.features ?? []).flatMap((feature) =>
        collectPbiIds(feature.items),
      );
      return { level: 'epic', title: epic.title ?? '', pbiIds };
    }

    for (const feature of epic.features ?? []) {
      if (feature.adoWorkItemId === adoWorkItemId) {
        return {
          level: 'feature',
          title: feature.title ?? '',
          pbiIds: collectPbiIds(feature.items),
        };
      }

      for (const item of feature.items ?? []) {
        if (item.adoWorkItemId === adoWorkItemId && item.id) {
          // A TBI can carry an ADO id too, but only PBIs own suites.
          if (!isPbiNode(item)) continue;
          return { level: 'pbi', title: item.title ?? '', pbiIds: [item.id] };
        }
      }
    }
  }

  return null;
}

/** Indexes a backlog's PBI nodes by id so suites can be annotated with ADO links. */
function indexPbiNodes(backlogJson: unknown): Map<string, BacklogNode> {
  const root = backlogJson as BacklogRoot | null;
  const byId = new Map<string, BacklogNode>();
  for (const epic of root?.epics ?? []) {
    for (const feature of epic.features ?? []) {
      for (const item of feature.items ?? []) {
        if (item.id) byId.set(item.id, item);
      }
    }
  }
  return byId;
}

function suitePbiId(suite: Record<string, unknown>): string | undefined {
  return (
    asString(suite.pbiId)
    ?? asString(suite.pbi_id)
    ?? asString(suite.workItemId)
    ?? asString(suite.work_item_id)
  );
}

function suiteCases(suite: Record<string, unknown>): unknown[] {
  if (Array.isArray(suite.testCases)) return suite.testCases;
  if (Array.isArray(suite.test_cases)) return suite.test_cases;
  if (Array.isArray(suite.cases)) return suite.cases;
  return [];
}

function normalizeSteps(value: unknown): QaLabTestCaseStep[] {
  return asArray(value).flatMap((entry, index) => {
    if (typeof entry === 'string') {
      return [{ order: index + 1, action: entry, expected: '' }];
    }
    const record = asRecord(entry);
    if (!record) return [];
    const action = asString(record.action) ?? asString(record.step) ?? '';
    if (!action) return [];
    const order = typeof record.order === 'number' ? record.order : index + 1;
    return [{ order, action, expected: asString(record.expected) ?? '' }];
  });
}

function normalizeTestData(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function normalizeTestCase(
  value: unknown,
  fallbackPbiId: string,
  index: number,
): QaLabTestCase | null {
  const record = asRecord(value);
  if (!record) return null;

  const title = asString(record.title) ?? asString(record.name);
  if (!title) return null;

  const traceability = asRecord(record.traceability);
  const automation = asRecord(record.automation);
  const acIndex = traceability?.acceptanceCriteriaIndex;

  return {
    id: asString(record.id) ?? `${fallbackPbiId}-TC-${index + 1}`,
    title,
    type: asString(record.type),
    tier: asString(record.tier),
    priority: asString(record.priority),
    persona: asString(record.persona),
    preconditions: asStringList(record.preconditions),
    testData: normalizeTestData(record.testData ?? record.test_data),
    steps: normalizeSteps(record.steps),
    expectedResult: asString(record.expectedResult) ?? asString(record.expected_result),
    automationTier:
      asString(automation?.recommendedTier) ?? asString(record.automationTier),
    automationCandidate:
      typeof automation?.candidate === 'boolean' ? automation.candidate : undefined,
    automationRationale: asString(automation?.rationale),
    featureFlag: asString(record.featureFlag) ?? null,
    featureFlagState: asString(record.featureFlagState) ?? null,
    acceptanceCriteriaIndex: typeof acIndex === 'number' ? acIndex : null,
    businessRules: asStringList(traceability?.businessRules),
    pbiId: asString(traceability?.pbiId) ?? fallbackPbiId,
  };
}

/**
 * Pulls the suites for `pbiIds` out of a test-cases JSON document, annotating each
 * with the ADO link of its PBI when the backlog has been pushed.
 */
function extractSuites(
  testCasesJson: unknown,
  pbiIds: string[],
  pbiNodes: Map<string, BacklogNode>,
): QaLabSuite[] {
  const root = asRecord(testCasesJson);
  if (!root) return [];

  const wanted = new Set(pbiIds);
  const suites: QaLabSuite[] = [];

  for (const rawSuite of asArray(root.suites)) {
    const suite = asRecord(rawSuite);
    if (!suite) continue;

    const pbiId = suitePbiId(suite);
    if (!pbiId || !wanted.has(pbiId)) continue;

    const cases = suiteCases(suite)
      .map((entry, index) => normalizeTestCase(entry, pbiId, index))
      .filter((entry): entry is QaLabTestCase => entry !== null);

    if (cases.length === 0) continue;

    const node = pbiNodes.get(pbiId);
    suites.push({
      pbiId,
      pbiTitle: asString(suite.pbiTitle) ?? node?.title ?? pbiId,
      featureTitle: asString(suite.featureTitle),
      epicTitle: asString(suite.epicTitle),
      featureFlag: asString(suite.featureFlag) ?? null,
      adoWorkItemId: node?.adoWorkItemId,
      adoWorkItemUrl: node?.adoWorkItemUrl,
      testCases: cases,
    });
  }

  return suites;
}

/**
 * Returns every generated test case tied to an ADO work item, across all PRDs in
 * the project. Empty `suites` means the work item is not linked to any generated
 * backlog, or its PBIs have no cases yet.
 */
export async function getTestCasesForWorkItem(
  project: string,
  workItemId: number,
): Promise<QaLabWorkItemTestCases> {
  const result: QaLabWorkItemTestCases = {
    workItemId,
    suites: [],
    sources: [],
    totalCases: 0,
  };

  const prdRows = await db
    .select({
      id: prds.id,
      title: prds.title,
      status: prds.status,
      backlogJson: prds.backlogJson,
      updatedAt: prds.updatedAt,
    })
    .from(prds)
    .where(eq(prds.project, project));

  for (const prdRow of prdRows) {
    const match = findBacklogMatch(prdRow.backlogJson, workItemId);
    if (!match || match.pbiIds.length === 0) continue;

    const testCaseRecord = await getTestCases(prdRow.id);
    if (!testCaseRecord?.testCasesJson) continue;

    const suites = extractSuites(
      testCaseRecord.testCasesJson,
      match.pbiIds,
      indexPbiNodes(prdRow.backlogJson),
    );
    if (suites.length === 0) continue;

    const source: QaLabSource = {
      prdId: prdRow.id,
      prdTitle: prdRow.title,
      prdStatus: prdRow.status,
      testCaseId: testCaseRecord.id,
      testCaseStatus: testCaseRecord.status,
      coverageSummary: testCaseRecord.coverageSummary ?? null,
      generatedAt: testCaseRecord.updatedAt,
      matchLevel: match.level,
      matchedTitle: match.title,
    };

    result.sources.push(source);
    result.suites.push(...suites);
  }

  result.totalCases = result.suites.reduce(
    (sum, suite) => sum + suite.testCases.length,
    0,
  );

  return result;
}
