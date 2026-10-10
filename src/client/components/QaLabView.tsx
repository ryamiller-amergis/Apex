import React, { useCallback, useMemo, useState } from 'react';
import type { QaLabSuite, QaLabTestCase } from '../../shared/types/qaLab';
import {
  useGenerateTestCasesForAdoWorkItem,
  useGenerateTestCasesForPrd,
  usePublishAdoTestSuite,
  useQaLabWorkItems,
  useWorkItemTestCases,
} from '../hooks/useQaLab';
import { QaLabAssistantPanel } from './QaLabAssistantPanel';
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

type FilterKey = 'tier' | 'type' | 'persona' | 'automationTier';

const FILTER_LABELS: Record<FilterKey, string> = {
  tier: 'Tier',
  type: 'Type',
  persona: 'Persona',
  automationTier: 'Automation',
};

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
          {testCase.automationTier && (
            <span className={`${styles.badge} ${styles.badgeAutomation}`}>
              {testCase.automationTier}
            </span>
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
              <ol className={styles.stepList}>
                {testCase.steps.map((step) => (
                  <li key={`${testCase.id}-step-${step.order}`}>
                    <span className={styles.stepAction}>{step.action}</span>
                    {step.expected && (
                      <span className={styles.stepExpected}>{step.expected}</span>
                    )}
                  </li>
                ))}
              </ol>
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
  expandedIds: Set<string>;
  onToggleCase: (id: string) => void;
}

const SuiteGroup: React.FC<SuiteGroupProps> = ({ suite, cases, expandedIds, onToggleCase }) => {
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

  const filterOptions = useMemo(
    () =>
      (Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => ({
        key,
        values: uniqueValues(allCases, key),
      })),
    [allCases],
  );

  const matchesFilters = useCallback(
    (testCase: QaLabTestCase) =>
      (Object.entries(filters) as [FilterKey, string | undefined][]).every(
        ([key, value]) => !value || testCase[key] === value,
      ),
    [filters],
  );

  const filteredCount = useMemo(
    () => allCases.filter(matchesFilters).length,
    [allCases, matchesFilters],
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
  }, []);

  const handleExpandAll = useCallback(() => {
    setExpandedIds(new Set(allCases.filter(matchesFilters).map((entry) => entry.id)));
  }, [allCases, matchesFilters]);

  const handleGenerate = useCallback(async () => {
    try {
      if (generation) {
        await generateTestCases.mutateAsync({
          prdId: generation.prdId,
          pbiIds: generation.pbiIds,
          matchLevel: generation.matchLevel,
          matchedTitle: generation.matchedTitle,
        });
      } else if (selectedWorkItemId && canGenerateExternally) {
        await generateAdoTestCases.mutateAsync({
          project,
          workItemId: selectedWorkItemId,
        });
      } else {
        return;
      }
      await refetch();
    } catch {
      // Mutation state renders the server error below the work-item header.
    }
  }, [
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
                      onClick={() => void handleGenerate()}
                      disabled={isGenerating}
                      {...{ 'data-testid': 'qa-lab-regenerate' }}
                    >
                      {isGenerating
                        ? 'Generating…'
                        : allCases.length > 0
                          ? 'Regenerate suite'
                          : 'Generate test cases'}
                    </button>
                  </>
                )}
              </div>
            </header>

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
                  {filteredCount} of {allCases.length} shown
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

            {(data?.suites ?? []).map((suite) => (
              <SuiteGroup
                key={`${suite.pbiId}-${suite.adoWorkItemId ?? 'unlinked'}`}
                suite={suite}
                cases={suite.testCases.filter(matchesFilters)}
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
