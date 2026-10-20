import React, { useCallback, useMemo, useState } from 'react';
import type { QaLabSuite, QaLabTestCase } from '../../shared/types/qaLab';
import {
  useAdoGenerationCandidates,
  useGenerateTestCasesForAdoWorkItem,
  useGenerateTestCasesForPrd,
  usePublishAdoTestSuite,
  useQaLabWorkItemDetail,
  useQaLabWorkItems,
  useWorkItemTestCases,
} from '../hooks/useQaLab';
import { env } from '../config/env';
import { QaLabAssistantPanel } from './QaLabAssistantPanel';
import { RichTextField } from './RichTextField';
import styles from './QaLabView.module.css';

export interface QaLabViewProps {
  project: string;
}

/** Work item types that can own or roll up generated test cases. */
const TESTABLE_TYPES = new Set([
  'Epic',
  'Feature',
  'Product Backlog Item',
  'Technical Backlog Item',
  'Bug',
]);

const WORK_ITEM_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'Epic', label: 'Epic' },
  { value: 'Feature', label: 'Feature' },
  { value: 'Product Backlog Item', label: 'PBI' },
  { value: 'Technical Backlog Item', label: 'TBI' },
  { value: 'Bug', label: 'Bug' },
];

type FilterKey = 'tier' | 'type';

const FILTER_LABELS: Record<FilterKey, string> = {
  tier: 'Tier',
  type: 'Type',
};

const ALL_USER_TYPES = '';

function userTypeOf(testCase: QaLabTestCase): string {
  return testCase.persona?.trim() || 'Unspecified';
}

/**
 * Manual holds every scenario a QA person runs by hand, including the ones
 * also tagged for Playwright. Automated holds unit and integration checks.
 */
type CaseKind = 'manual' | 'e2e' | 'automated';

const CASE_TABS: { key: CaseKind; label: string; hint: string }[] = [
  { key: 'manual', label: 'Manual', hint: 'Scenarios QA runs by hand, including those also marked for E2E' },
  { key: 'e2e', label: 'E2E', hint: 'User-facing paths marked for Playwright automation' },
  { key: 'automated', label: 'Automated', hint: 'Unit and integration checks for developers' },
];

const COVERAGE_TIERS = ['happy', 'error', 'edge', 'negative'] as const;

function isOnTab(testCase: QaLabTestCase, tab: CaseKind): boolean {
  const tier = testCase.automationTier;
  const isAutomatedOnly = tier === 'unit' || tier === 'integration';
  switch (tab) {
    case 'manual':
      return !isAutomatedOnly;
    case 'e2e':
      return tier === 'e2e-playwright';
    case 'automated':
      return isAutomatedOnly;
    default: {
      const unhandled: never = tab;
      throw new Error(`Unknown case tab: ${String(unhandled)}`);
    }
  }
}

interface ScopeOption {
  key: string;
  label: string;
  meta: string;
}

function uniqueValues(cases: QaLabTestCase[], key: FilterKey): string[] {
  const values = new Set<string>();
  for (const testCase of cases) {
    const value = testCase[key];
    if (typeof value === 'string' && value.length > 0) values.add(value);
  }
  return Array.from(values).sort();
}

/* ── Test case card ──────────────────────────────────────────────────────── */

interface TestCaseCardProps {
  testCase: QaLabTestCase;
  expanded: boolean;
  onToggle: () => void;
}

const TestCaseCard: React.FC<TestCaseCardProps> = ({ testCase, expanded, onToggle }) => {
  const traceBits = [
    testCase.acceptanceCriteriaIndex != null ? `AC-${testCase.acceptanceCriteriaIndex + 1}` : null,
    ...testCase.businessRules,
  ].filter((bit): bit is string => bit !== null);

  return (
    <div
      className={`${styles.card} ${expanded ? styles.cardExpanded : ''}`}
      {...{ 'data-testid': `qa-lab-case-${testCase.id}` }}
    >
      <button
        type="button"
        className={styles.cardHeader}
        onClick={onToggle}
        aria-expanded={expanded}
        {...{ 'data-testid': `qa-lab-case-toggle-${testCase.id}` }}
      >
        <span className={styles.caseId}>{testCase.id}</span>
        <span className={styles.caseTitle}>{testCase.title}</span>
        <span className={styles.caseBadges}>
          {testCase.tier && <span className={styles.badge}>{testCase.tier}</span>}
          {testCase.type && <span className={styles.badge}>{testCase.type}</span>}
          {testCase.persona && <span className={styles.badge}>{testCase.persona}</span>}
          {testCase.automationTier === 'e2e-playwright' && (
            <span className={`${styles.badge} ${styles.badgeAutomation}`}>E2E</span>
          )}
        </span>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {expanded && (
        <div className={styles.cardBody}>
          <dl className={styles.metaGrid}>
            {testCase.persona && (
              <>
                <dt>Persona</dt>
                <dd>{testCase.persona}</dd>
              </>
            )}
            {testCase.priority && (
              <>
                <dt>Priority</dt>
                <dd>{testCase.priority}</dd>
              </>
            )}
            {testCase.featureFlag && (
              <>
                <dt>Feature flag</dt>
                <dd>
                  {testCase.featureFlag}
                  {testCase.featureFlagState ? ` (${testCase.featureFlagState})` : ''}
                </dd>
              </>
            )}
            {traceBits.length > 0 && (
              <>
                <dt>Traces to</dt>
                <dd>{traceBits.join(', ')}</dd>
              </>
            )}
          </dl>

          {testCase.preconditions.length > 0 && (
            <section className={styles.section}>
              <h4 className={styles.sectionLabel}>Preconditions</h4>
              <ul className={styles.bulletList}>
                {testCase.preconditions.map((precondition, index) => (
                  <li key={`${testCase.id}-pre-${index}`}>{precondition}</li>
                ))}
              </ul>
            </section>
          )}

          {Object.keys(testCase.testData).length > 0 && (
            <section className={styles.section}>
              <h4 className={styles.sectionLabel}>Test data</h4>
              <ul className={styles.bulletList}>
                {Object.entries(testCase.testData).map(([key, value]) => (
                  <li key={`${testCase.id}-data-${key}`}>
                    <code className={styles.dataKey}>{key}</code> {value}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {testCase.steps.length > 0 && (
            <section className={styles.section}>
              <h4 className={styles.sectionLabel}>Steps</h4>
              <table className={styles.stepTable}>
                <thead>
                  <tr>
                    <th scope="col" className={styles.stepNumberCol}>Step</th>
                    <th scope="col">Action</th>
                    <th scope="col">Expected</th>
                    <th scope="col" className={styles.stepActualCol}>Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {testCase.steps.map((step, index) => (
                    <tr key={`${testCase.id}-step-${step.order}`}>
                      <td className={styles.stepNumberCol}>{index + 1}</td>
                      <td className={styles.stepAction}>{step.action}</td>
                      <td className={styles.stepExpected}>{step.expected}</td>
                      <td className={styles.stepActualCol} aria-label="Recorded when the case is run" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {testCase.expectedResult && (
            <section className={styles.section}>
              <h4 className={styles.sectionLabel}>Expected result</h4>
              <p className={styles.expectedResult}>{testCase.expectedResult}</p>
            </section>
          )}

          {testCase.automationCandidate === false && testCase.automationRationale && (
            <p className={styles.automationNote}>
              Not an automation candidate — {testCase.automationRationale}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/* ── Suite group ─────────────────────────────────────────────────────────── */

interface SuiteGroupProps {
  suite: QaLabSuite;
  cases: QaLabTestCase[];
  /** Manual-tab cases for this suite, used for the coverage strip. */
  manualCases: QaLabTestCase[] | null;
  expandedIds: Set<string>;
  onToggleCase: (id: string) => void;
}

const ManualCoverage: React.FC<{ suiteId: string; cases: QaLabTestCase[] }> = ({ suiteId, cases }) => {
  const tiers = new Set(cases.map((entry) => entry.tier).filter(Boolean));
  const acIndices = Array.from(new Set(
    cases
      .map((entry) => entry.acceptanceCriteriaIndex)
      .filter((index): index is number => typeof index === 'number'),
  )).sort((left, right) => left - right);
  const missing = COVERAGE_TIERS.filter((tier) => !tiers.has(tier));

  return (
    <div className={styles.coverage} {...{ 'data-testid': `qa-lab-coverage-${suiteId}` }}>
      {COVERAGE_TIERS.map((tier) => (
        <span
          key={tier}
          className={`${styles.coverageChip} ${tiers.has(tier) ? styles.coverageChipOn : styles.coverageChipOff}`}
        >
          {tiers.has(tier) ? '✓' : '–'} {tier}
        </span>
      ))}
      <span className={styles.coverageAc}>
        {acIndices.length > 0
          ? `AC covered: ${acIndices.map((index) => index + 1).join(', ')}`
          : 'No acceptance criteria traced'}
      </span>
      {missing.length > 0 && (
        <span className={styles.coverageWarn}>Missing {missing.join(', ')} scenarios</span>
      )}
    </div>
  );
};

const SuiteGroup: React.FC<SuiteGroupProps> = ({
  suite,
  cases,
  manualCases,
  expandedIds,
  onToggleCase,
}) => {
  if (cases.length === 0) return null;

  return (
    <section className={styles.suite} {...{ 'data-testid': `qa-lab-suite-${suite.pbiId}` }}>
      <header className={styles.suiteHeader}>
        <div className={styles.suiteTitleRow}>
          <span className={styles.suitePbiId}>{suite.pbiId}</span>
          <h3 className={styles.suiteTitle}>{suite.pbiTitle}</h3>
          <span className={styles.suiteCount}>
            {cases.length} {cases.length === 1 ? 'case' : 'cases'}
          </span>
        </div>
        <div className={styles.suiteMeta}>
          {suite.featureTitle && <span>{suite.featureTitle}</span>}
          {suite.featureFlag && <span>Flag: {suite.featureFlag}</span>}
          {suite.adoWorkItemUrl && (
            <a
              href={suite.adoWorkItemUrl}
              target="_blank"
              rel="noreferrer"
              className={styles.adoLink}
              {...{ 'data-testid': `qa-lab-suite-ado-link-${suite.pbiId}` }}
            >
              #{suite.adoWorkItemId} in Azure DevOps
            </a>
          )}
        </div>
        {manualCases && <ManualCoverage suiteId={suite.pbiId} cases={manualCases} />}
      </header>

      <div className={styles.caseList}>
        {cases.map((testCase) => (
          // data-testid-exempt — TestCaseCard sets qa-lab-case-{id} on its own root
          <TestCaseCard
            key={testCase.id}
            testCase={testCase}
            expanded={expandedIds.has(testCase.id)}
            onToggle={() => onToggleCase(testCase.id)}
          />
        ))}
      </div>
    </section>
  );
};

/* ── QA Lab ──────────────────────────────────────────────────────────────── */

export const QaLabView: React.FC<QaLabViewProps> = ({ project }) => {
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [workItemType, setWorkItemType] = useState('');
  const [workItemState, setWorkItemState] = useState('');
  const [filters, setFilters] = useState<Partial<Record<FilterKey, string>>>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CaseKind>('manual');
  const [activeUserType, setActiveUserType] = useState(ALL_USER_TYPES);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeSelection, setScopeSelection] = useState<Set<string> | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const workItemDetail = useQaLabWorkItemDetail(project, selectedWorkItemId, detailsOpen);
  const adoWorkItemUrl = selectedWorkItemId
    ? `https://dev.azure.com/${encodeURIComponent(env.VITE_ADO_ORG)}/${encodeURIComponent(project)}/_workitems/edit/${selectedWorkItemId}`
    : null;

  const {
    data: workItemList,
    isLoading: isLoadingWorkItems,
    isError: isWorkItemListError,
    error: workItemListError,
  } = useQaLabWorkItems(project);
  const { data, isLoading, isError, error, refetch } = useWorkItemTestCases(
    project,
    selectedWorkItemId,
  );
  const generateTestCases = useGenerateTestCasesForPrd();
  const generateAdoTestCases = useGenerateTestCasesForAdoWorkItem();
  const publishAdoSuite = usePublishAdoTestSuite();

  const testableItems = useMemo(
    () => (workItemList?.items ?? []).filter((item) => TESTABLE_TYPES.has(item.workItemType)),
    [workItemList?.items],
  );

  const stateOptions = useMemo(() => {
    const source = workItemType
      ? testableItems.filter((item) => item.workItemType === workItemType)
      : testableItems;
    return Array.from(new Set(source.map((item) => item.state).filter(Boolean))).sort();
  }, [testableItems, workItemType]);

  const visibleWorkItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return testableItems.filter((item) => {
      if (workItemType && item.workItemType !== workItemType) return false;
      if (workItemState && item.state !== workItemState) return false;
      if (!term) return true;
      return item.title.toLowerCase().includes(term) || String(item.id).includes(term);
    });
  }, [testableItems, search, workItemType, workItemState]);

  const selectedWorkItem = useMemo(
    () => testableItems.find((item) => item.id === selectedWorkItemId) ?? null,
    [testableItems, selectedWorkItemId],
  );

  const allCases = useMemo(
    () => (data?.suites ?? []).flatMap((suite) => suite.testCases),
    [data?.suites],
  );

  const tabCounts = useMemo(() => {
    const counts: Record<CaseKind, number> = { manual: 0, e2e: 0, automated: 0 };
    for (const tab of CASE_TABS) {
      counts[tab.key] = allCases.filter((entry) => isOnTab(entry, tab.key)).length;
    }
    return counts;
  }, [allCases]);

  const kindCases = useMemo(
    () => allCases.filter((entry) => isOnTab(entry, activeTab)),
    [allCases, activeTab],
  );

  const userTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of kindCases) {
      const userType = userTypeOf(entry);
      counts.set(userType, (counts.get(userType) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [kindCases]);

  const showUserTypeTabs = activeTab !== 'automated' && userTypeCounts.length > 1;
  const effectiveUserType = showUserTypeTabs ? activeUserType : ALL_USER_TYPES;

  const matchesUserType = useCallback(
    (testCase: QaLabTestCase) =>
      effectiveUserType === ALL_USER_TYPES || userTypeOf(testCase) === effectiveUserType,
    [effectiveUserType],
  );

  const tabCases = useMemo(
    () => kindCases.filter(matchesUserType),
    [kindCases, matchesUserType],
  );

  const filterOptions = useMemo(
    () =>
      (Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => ({
        key,
        values: uniqueValues(tabCases, key),
      })),
    [tabCases],
  );

  const matchesFilters = useCallback(
    (testCase: QaLabTestCase) =>
      (Object.entries(filters) as [FilterKey, string | undefined][]).every(
        ([key, value]) => !value || testCase[key] === value,
      ),
    [filters],
  );

  const filteredCount = useMemo(
    () => tabCases.filter(matchesFilters).length,
    [tabCases, matchesFilters],
  );

  const primarySource = data?.sources?.[0] ?? null;
  const generation = data?.generation ?? null;
  const externalSuite = data?.externalSuite ?? null;
  const canGenerateExternally = selectedWorkItem != null
    && selectedWorkItem.workItemType !== 'Technical Backlog Item';
  const canGenerate = generation != null || canGenerateExternally;
  const isGenerating = generateTestCases.isPending
    || generateAdoTestCases.isPending
    || generation?.testCaseStatus === 'generating'
    || externalSuite?.status === 'generating';
  const publishedCaseIds = useMemo(
    () => new Set((externalSuite?.publishedCases ?? []).map((entry) => entry.localCaseId)),
    [externalSuite?.publishedCases],
  );
  const unpublishedCount = allCases.filter((entry) => !publishedCaseIds.has(entry.id)).length;

  const adoCandidates = useAdoGenerationCandidates(
    project,
    selectedWorkItemId,
    scopeOpen && generation == null && canGenerateExternally,
  );

  const scopeOptions = useMemo<ScopeOption[]>(() => {
    if (generation) {
      return generation.pbiTargets.map((target) => ({
        key: target.pbiId,
        label: target.title,
        meta: target.pbiId,
      }));
    }
    return (adoCandidates.data?.items ?? []).map((item) => ({
      key: String(item.id),
      label: item.title,
      meta: `${item.workItemType === 'Product Backlog Item' ? 'PBI' : item.workItemType} #${item.id} · ${item.state}`,
    }));
  }, [generation, adoCandidates.data?.items]);

  const defaultScope = useMemo(() => {
    const keys = scopeOptions.map((option) => option.key);
    const rootKey = selectedWorkItemId ? String(selectedWorkItemId) : null;
    if (!generation && rootKey && keys.includes(rootKey)) return new Set([rootKey]);
    return new Set(keys);
  }, [scopeOptions, generation, selectedWorkItemId]);

  const activeScope = scopeSelection ?? defaultScope;
  const isLoadingScope = generation == null && adoCandidates.isLoading;

  const toggleCase = useCallback((id: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectWorkItem = useCallback((id: number) => {
    setSelectedWorkItemId(id);
    setFilters({});
    setExpandedIds(new Set());
    setScopeOpen(false);
    setScopeSelection(null);
    setDetailsOpen(false);
    setActiveUserType(ALL_USER_TYPES);
  }, []);

  const handleExpandAll = useCallback(() => {
    setExpandedIds(new Set(tabCases.filter(matchesFilters).map((entry) => entry.id)));
  }, [tabCases, matchesFilters]);

  const toggleScopeKey = useCallback((key: string) => {
    setScopeSelection((previous) => {
      const next = new Set(previous ?? defaultScope);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [defaultScope]);

  const handleGenerate = useCallback(async () => {
    const chosen = scopeOptions.map((option) => option.key).filter((key) => activeScope.has(key));
    if (chosen.length === 0) return;
    try {
      if (generation) {
        await generateTestCases.mutateAsync({
          prdId: generation.prdId,
          pbiIds: chosen,
          matchLevel: generation.matchLevel,
          matchedTitle: generation.matchedTitle,
        });
      } else if (selectedWorkItemId && canGenerateExternally) {
        await generateAdoTestCases.mutateAsync({
          project,
          workItemId: selectedWorkItemId,
          targetIds: chosen.map(Number),
        });
      } else {
        return;
      }
      setScopeOpen(false);
      setScopeSelection(null);
      await refetch();
    } catch {
      // Mutation state renders the server error below the work-item header.
    }
  }, [
    scopeOptions,
    activeScope,
    generation,
    generateTestCases,
    selectedWorkItemId,
    canGenerateExternally,
    generateAdoTestCases,
    project,
    refetch,
  ]);

  const handlePublish = useCallback(async () => {
    if (!externalSuite || unpublishedCount === 0) return;
    try {
      await publishAdoSuite.mutateAsync({ suiteId: externalSuite.id });
      await refetch();
    } catch {
      // Mutation state renders the server error below the work-item header.
    }
  }, [externalSuite, unpublishedCount, publishAdoSuite, refetch]);

  return (
    <div className={styles.layout} {...{ 'data-testid': 'qa-lab-view' }}>
      {/* ── Work item picker ── */}
      <aside className={styles.sidebar} aria-label="Work items">
        <div className={styles.sidebarHeader}>
          <h2 className={styles.sidebarTitle}>Work items</h2>
          <span className={styles.sidebarCount}>{visibleWorkItems.length}</span>
        </div>
        <div className={styles.sidebarFilters}>
          <label className={styles.sidebarFilterLabel}>
            Type
            <select
              className={styles.sidebarFilterSelect}
              value={workItemType}
              onChange={(event) => {
                setWorkItemType(event.target.value);
                setWorkItemState('');
              }}
              aria-label="Filter by work item type"
              {...{ 'data-testid': 'qa-lab-filter-work-item-type' }}
            >
              <option value="">All types</option>
              {WORK_ITEM_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className={styles.sidebarFilterLabel}>
            State
            <select
              className={styles.sidebarFilterSelect}
              value={workItemState}
              onChange={(event) => setWorkItemState(event.target.value)}
              aria-label="Filter by work item state"
              {...{ 'data-testid': 'qa-lab-filter-work-item-state' }}
            >
              <option value="">All states</option>
              {stateOptions.map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </select>
          </label>
        </div>
        <input
          type="search"
          className={styles.search}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by title or ID…"
          aria-label="Search work items"
          {...{ 'data-testid': 'qa-lab-work-item-search' }}
        />
        <ul className={styles.workItemList}>
          {visibleWorkItems.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`${styles.workItemButton} ${
                  item.id === selectedWorkItemId ? styles.workItemButtonActive : ''
                }`}
                onClick={() => handleSelectWorkItem(item.id)}
                {...{ 'data-testid': `qa-lab-work-item-${item.id}` }}
              >
                <span className={styles.workItemMeta}>
                  <span className={styles.workItemType}>{item.workItemType}</span>
                  <span className={styles.workItemId}>#{item.id}</span>
                </span>
                <span className={styles.workItemTitle}>{item.title}</span>
                <span className={styles.workItemState}>{item.state}</span>
              </button>
            </li>
          ))}
          {isLoadingWorkItems && (
            <li className={styles.sidebarEmpty} {...{ 'data-testid': 'qa-lab-work-items-loading' }}>
              Loading work items…
            </li>
          )}
          {isWorkItemListError && (
            <li className={`${styles.sidebarEmpty} ${styles.statusError}`} {...{ 'data-testid': 'qa-lab-work-items-error' }}>
              {workItemListError instanceof Error ? workItemListError.message : 'Could not load work items.'}
            </li>
          )}
          {!isLoadingWorkItems && !isWorkItemListError && visibleWorkItems.length === 0 && (
            <li className={styles.sidebarEmpty}>
              {search.trim() || workItemType || workItemState
                ? 'No matching work items.'
                : 'No work items in this project.'}
            </li>
          )}
          {!isLoadingWorkItems && workItemList?.truncated && (
            <li className={styles.sidebarEmpty}>
              Showing the 20,000 most recently changed items.
            </li>
          )}
        </ul>
      </aside>

      {/* ── Test cases ── */}
      <main className={styles.content}>
        {!selectedWorkItemId ? (
          <div className={styles.placeholder} {...{ 'data-testid': 'qa-lab-placeholder' }}>
            <h2 className={styles.placeholderTitle}>Select a work item</h2>
            <p className={styles.placeholderBody}>
              Pick a PBI, Feature, or Epic to see the test cases already generated for it. Choosing
              a Feature or Epic rolls up the cases of every backlog item beneath it.
            </p>
          </div>
        ) : (
          <>
            <header className={styles.contentHeader}>
              <div className={styles.contentTitleRow}>
                <h2 className={styles.contentTitle}>
                  {selectedWorkItem?.title ?? `Work item #${selectedWorkItemId}`}
                </h2>
                <span className={styles.contentSubtitle}>
                  #{selectedWorkItemId}
                  {selectedWorkItem?.workItemType ? ` · ${selectedWorkItem.workItemType}` : ''}
                  {selectedWorkItem?.state ? ` · ${selectedWorkItem.state}` : ''}
                </span>
                <span className={styles.workItemLinks}>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => setDetailsOpen((open) => !open)}
                    aria-expanded={detailsOpen}
                    {...{ 'data-testid': 'qa-lab-toggle-work-item-details' }}
                  >
                    {detailsOpen ? 'Hide details' : 'View details'}
                  </button>
                  {adoWorkItemUrl && (
                    <a
                      href={adoWorkItemUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={styles.adoLink}
                      {...{ 'data-testid': 'qa-lab-open-work-item-ado' }}
                    >
                      Open in Azure DevOps ↗
                    </a>
                  )}
                </span>
              </div>

              <div className={styles.contentActions}>
                {canGenerate && (
                  <>
                    {generation && (
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => setAssistantOpen(true)}
                        {...{ 'data-testid': 'qa-lab-open-assistant' }}
                      >
                        Ask QA Assistant
                      </button>
                    )}
                    {externalSuite?.status === 'ready' && allCases.length > 0 && (
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => void handlePublish()}
                        disabled={publishAdoSuite.isPending || unpublishedCount === 0}
                        {...{ 'data-testid': 'qa-lab-publish-ado' }}
                      >
                        {publishAdoSuite.isPending
                          ? 'Publishing…'
                          : unpublishedCount === 0
                            ? 'Published to ADO'
                            : `Publish ${unpublishedCount} to ADO`}
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.primaryBtn}
                      onClick={() => setScopeOpen((open) => !open)}
                      disabled={isGenerating}
                      aria-expanded={scopeOpen}
                      {...{ 'data-testid': 'qa-lab-regenerate' }}
                    >
                      {isGenerating
                        ? 'Generating…'
                        : allCases.length > 0
                          ? 'Regenerate…'
                          : 'Generate test cases…'}
                    </button>
                  </>
                )}
              </div>
            </header>

            {detailsOpen && (
              <section className={styles.detailsPanel} aria-label="Work item details" {...{ 'data-testid': 'qa-lab-work-item-details' }}>
                {workItemDetail.isLoading && <p className={styles.status}>Loading work item…</p>}
                {workItemDetail.isError && (
                  <p className={`${styles.status} ${styles.statusError}`}>
                    {workItemDetail.error instanceof Error ? workItemDetail.error.message : 'Could not load the work item.'}
                  </p>
                )}
                {workItemDetail.data && (
                  <>
                    <dl className={styles.metaGrid}>
                      <dt>Assigned to</dt>
                      <dd>{workItemDetail.data.assignedTo ?? 'Unassigned'}</dd>
                      {workItemDetail.data.iterationPath && (
                        <>
                          <dt>Iteration</dt>
                          <dd>{workItemDetail.data.iterationPath}</dd>
                        </>
                      )}
                      {workItemDetail.data.areaPath && (
                        <>
                          <dt>Area</dt>
                          <dd>{workItemDetail.data.areaPath}</dd>
                        </>
                      )}
                      {workItemDetail.data.tags && (
                        <>
                          <dt>Tags</dt>
                          <dd>{workItemDetail.data.tags}</dd>
                        </>
                      )}
                    </dl>
                    <RichTextField
                      label="Description"
                      content={workItemDetail.data.description}
                      defaultExpanded
                      {...{ 'data-testid': 'qa-lab-work-item-description' }}
                    />
                    {workItemDetail.data.workItemType === 'Bug' ? (
                      <RichTextField
                        label="Repro steps"
                        content={workItemDetail.data.reproSteps}
                        defaultExpanded
                        {...{ 'data-testid': 'qa-lab-work-item-repro-steps' }}
                      />
                    ) : (
                      <RichTextField
                        label="Acceptance criteria"
                        content={workItemDetail.data.acceptanceCriteria}
                        defaultExpanded
                        {...{ 'data-testid': 'qa-lab-work-item-acceptance-criteria' }}
                      />
                    )}
                  </>
                )}
              </section>
            )}

            {scopeOpen && !isGenerating && (
              <section className={styles.scopePanel} aria-label="Choose items to generate" {...{ 'data-testid': 'qa-lab-scope-panel' }}>
                <div className={styles.scopeHeader}>
                  <h3 className={styles.scopeTitle}>Which items should get test cases?</h3>
                  <span className={styles.scopeHint}>
                    PBIs and Bugs under this item. TBIs are read as technical context only.
                  </span>
                </div>
                {isLoadingScope && <p className={styles.status}>Loading items…</p>}
                {adoCandidates.isError && (
                  <p className={`${styles.status} ${styles.statusError}`}>
                    {adoCandidates.error instanceof Error ? adoCandidates.error.message : 'Could not load items.'}
                  </p>
                )}
                {!isLoadingScope && scopeOptions.length === 0 && !adoCandidates.isError && (
                  <p className={styles.status}>There are no PBIs or Bugs under this item to test.</p>
                )}
                {scopeOptions.length > 0 && (
                  <>
                    <div className={styles.scopeBulk}>
                      <button
                        type="button"
                        className={styles.linkBtn}
                        onClick={() => setScopeSelection(new Set(scopeOptions.map((option) => option.key)))}
                        {...{ 'data-testid': 'qa-lab-scope-select-all' }}
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        className={styles.linkBtn}
                        onClick={() => setScopeSelection(new Set())}
                        {...{ 'data-testid': 'qa-lab-scope-select-none' }}
                      >
                        Clear
                      </button>
                    </div>
                    <ul className={styles.scopeList}>
                      {scopeOptions.map((option) => (
                        <li key={option.key}>
                          <label className={styles.scopeOption}>
                            <input
                              type="checkbox"
                              checked={activeScope.has(option.key)}
                              onChange={() => toggleScopeKey(option.key)}
                              {...{ 'data-testid': `qa-lab-scope-option-${option.key}` }}
                            />
                            <span className={styles.scopeOptionText}>
                              <span className={styles.scopeOptionLabel}>{option.label}</span>
                              <span className={styles.scopeOptionMeta}>{option.meta}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className={styles.scopeActions}>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setScopeOpen(false);
                      setScopeSelection(null);
                    }}
                    {...{ 'data-testid': 'qa-lab-scope-cancel' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    onClick={() => void handleGenerate()}
                    disabled={activeScope.size === 0 || scopeOptions.length === 0}
                    {...{ 'data-testid': 'qa-lab-scope-generate' }}
                  >
                    Generate for {activeScope.size} {activeScope.size === 1 ? 'item' : 'items'}
                  </button>
                </div>
              </section>
            )}

            {(generation?.testCaseStatus === 'failed' || externalSuite?.status === 'failed') && (
              <p className={`${styles.status} ${styles.statusError}`} {...{ 'data-testid': 'qa-lab-generation-failed' }}>
                The last test-case generation did not produce any cases. Try generating again.
              </p>
            )}

            {(generateTestCases.error || generateAdoTestCases.error || publishAdoSuite.error) && (
              <p className={`${styles.status} ${styles.statusError}`} {...{ 'data-testid': 'qa-lab-action-error' }}>
                {(generateTestCases.error ?? generateAdoTestCases.error ?? publishAdoSuite.error)?.message}
              </p>
            )}

            {(generation || externalSuite) && (
              <div className={styles.provenance} {...{ 'data-testid': 'qa-lab-provenance' }}>
                {generation ? (
                  <>
                    <span>
                      From PRD <strong>{generation.prdTitle}</strong>
                      {primarySource ? ` (${primarySource.prdStatus})` : ''}
                    </span>
                    <span>
                      Matched at {generation.matchLevel} level: {generation.matchedTitle}
                    </span>
                  </>
                ) : (
                  <>
                    <span>Generated directly from Azure DevOps</span>
                    <span>{externalSuite?.publishedCases.length ?? 0} cases published to ADO</span>
                  </>
                )}
                {primarySource?.coverageSummary && (
                  <span>
                    {primarySource.coverageSummary.totalCases} cases ·{' '}
                    AC {primarySource.coverageSummary.acCovered} ·{' '}
                    BR {primarySource.coverageSummary.brCovered} ·{' '}
                    {primarySource.coverageSummary.gaps} gaps
                  </span>
                )}
              </div>
            )}

            {allCases.length > 0 && (
              <div className={styles.tabs} role="tablist" aria-label="Test case kind">
                {CASE_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.key}
                    title={tab.hint}
                    className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
                    onClick={() => {
                      setActiveTab(tab.key);
                      setActiveUserType(ALL_USER_TYPES);
                      setFilters({});
                    }}
                    {...{ 'data-testid': `qa-lab-tab-${tab.key}` }}
                  >
                    {tab.label}
                    <span className={styles.tabCount}>{tabCounts[tab.key]}</span>
                  </button>
                ))}
              </div>
            )}

            {allCases.length > 0 && showUserTypeTabs && (
              <div className={styles.userTypeTabs} role="tablist" aria-label="User type">
                {[[ALL_USER_TYPES, kindCases.length] as const, ...userTypeCounts].map(([userType, count]) => (
                  <button
                    key={userType || 'all'}
                    type="button"
                    role="tab"
                    aria-selected={effectiveUserType === userType}
                    className={`${styles.userTypeTab} ${effectiveUserType === userType ? styles.userTypeTabActive : ''}`}
                    onClick={() => {
                      setActiveUserType(userType);
                      setFilters({});
                    }}
                    {...{ 'data-testid': `qa-lab-user-type-${userType ? userType.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'all'}` }}
                  >
                    {userType || 'All users'}
                    <span className={styles.tabCount}>{count}</span>
                  </button>
                ))}
              </div>
            )}

            {allCases.length > 0 && (
              <div className={styles.toolbar} {...{ 'data-testid': 'qa-lab-toolbar' }}>
                {filterOptions.map(({ key, values }) =>
                  values.length > 1 ? (
                    <label key={key} className={styles.filterLabel}>
                      {FILTER_LABELS[key]}
                      <select
                        className={styles.filterSelect}
                        value={filters[key] ?? ''}
                        onChange={(event) =>
                          setFilters((previous) => ({
                            ...previous,
                            [key]: event.target.value || undefined,
                          }))
                        }
                        {...{ 'data-testid': `qa-lab-filter-${key}` }}
                      >
                        <option value="">All</option>
                        {values.map((value) => (
                          <option key={value} value={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                  ) : null,
                )}
                <span className={styles.toolbarSpacer} />
                <span className={styles.resultCount}>
                  {filteredCount} of {tabCases.length} shown
                </span>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={handleExpandAll}
                  {...{ 'data-testid': 'qa-lab-expand-all' }}
                >
                  Expand all
                </button>
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => setExpandedIds(new Set())}
                  {...{ 'data-testid': 'qa-lab-collapse-all' }}
                >
                  Collapse all
                </button>
              </div>
            )}

            {isLoading && (
              <p className={styles.status} {...{ 'data-testid': 'qa-lab-loading' }}>
                Loading test cases…
              </p>
            )}

            {isError && (
              <p className={`${styles.status} ${styles.statusError}`} {...{ 'data-testid': 'qa-lab-error' }}>
                {error instanceof Error ? error.message : 'Could not load test cases.'}
              </p>
            )}

            {!isLoading && !isError && allCases.length === 0 && (
              <div className={styles.placeholder} {...{ 'data-testid': 'qa-lab-empty' }}>
                <h2 className={styles.placeholderTitle}>No generated test cases</h2>
                <p className={styles.placeholderBody}>
                  {generation
                    ? 'This work item is in an Apex backlog, and it has no test cases yet. Generate them for the selected backlog item.'
                    : selectedWorkItem?.workItemType === 'Technical Backlog Item'
                      ? 'TBIs provide technical context to their parent requirement and do not own test cases.'
                      : 'Generate test cases directly from this Azure DevOps work item.'}
                </p>
              </div>
            )}

            {allCases.length > 0 && tabCases.length === 0 && (
              <p className={styles.status} {...{ 'data-testid': 'qa-lab-tab-empty' }}>
                No {CASE_TABS.find((tab) => tab.key === activeTab)?.label} cases in this suite.
              </p>
            )}

            {(data?.suites ?? []).map((suite) => (
              <SuiteGroup
                key={`${suite.pbiId}-${suite.adoWorkItemId ?? 'unlinked'}`}
                suite={suite}
                cases={suite.testCases.filter(
                  (entry) => isOnTab(entry, activeTab) && matchesUserType(entry) && matchesFilters(entry),
                )}
                manualCases={activeTab === 'manual'
                  ? suite.testCases.filter((entry) => isOnTab(entry, 'manual') && matchesUserType(entry))
                  : null}
                expandedIds={expandedIds}
                onToggleCase={toggleCase}
              />
            ))}
          </>
        )}
      </main>

      {assistantOpen && generation && (
        // data-testid-exempt — QaLabAssistantPanel owns its panel chrome
        <QaLabAssistantPanel
          prdId={generation.prdId}
          contextLabel={selectedWorkItem?.title ?? `Work item #${selectedWorkItemId}`}
          open={assistantOpen}
          onClose={() => setAssistantOpen(false)}
          onRunComplete={() => void refetch()}
        />
      )}
    </div>
  );
};

export default QaLabView;
