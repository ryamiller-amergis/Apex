import React, { useEffect, useId, useRef, useState } from 'react';
import { useApexFeatureContext } from '../hooks/useApexBacklog';
import type {
  ApexFeatureContextBacklogItem,
  ApexFeatureContextPrototype,
  BacklogFeatureItem,
} from '../../shared/types/devWorkbench';
import type { UiMock } from '../../shared/types/backlog';
import {
  computeFeatureWorkStatus,
  formatMyWorkStatusLabel,
} from '../../shared/utils/myWorkStatus';
import { useActiveSessions } from '../hooks/useDevWorkbench';
import { MarkdownWithMermaid } from './MarkdownWithMermaid';
import { UiMockPreview } from './UiMockPreview';
import styles from './FeatureContextModal.module.css';

export interface FeatureContextModalProps {
  project: string;
  feature: BacklogFeatureItem;
  onClose: () => void;
}

type TabId = 'prd' | 'backlog' | 'design' | 'tech' | 'assumptions' | 'prototype';

const TABS: { id: TabId; label: string }[] = [
  { id: 'prd', label: 'PRD' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'design', label: 'Design Doc' },
  { id: 'tech', label: 'Tech Spec' },
  { id: 'assumptions', label: 'Assumptions' },
  { id: 'prototype', label: 'Prototype' },
];

function prototypeToUiMock(proto: ApexFeatureContextPrototype): UiMock {
  return {
    decision: 'new-page',
    rationale: 'Feature context prototype preview',
    mockHtml: proto.mockHtml,
    mockVersion: proto.mockVersion,
    status: proto.status === 'approved' ? 'approved' : 'draft',
    history: proto.history.map((h) => ({
      version: h.version,
      decision: 'new-page' as const,
      rationale: '',
      mockHtml: h.html,
      feedback: h.feedback,
      createdAt: h.createdAt,
    })),
  };
}

const BacklogItemCard: React.FC<{
  item: ApexFeatureContextBacklogItem;
  'data-testid'?: string;
}> = ({ item, 'data-testid': testId }) => {
  const [expanded, setExpanded] = useState(false);
  const hasDetails =
    !!item.description ||
    (item.acceptanceCriteria && item.acceptanceCriteria.length > 0) ||
    (item.definitionOfDone && item.definitionOfDone.length > 0) ||
    (item.dependencies && item.dependencies.length > 0);

  return (
    <div
      className={styles['backlog-item']}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <button
        type="button"
        className={styles['backlog-item-header']}
        onClick={() => hasDetails && setExpanded((v) => !v)}
        aria-expanded={hasDetails ? expanded : undefined}
        disabled={!hasDetails}
        {...{ 'data-testid': `feature-context-backlog-item-toggle-${item.id}` }}
      >
        <span className={styles['backlog-item-id']}>{item.id}</span>
        <span className={styles['backlog-item-title']}>{item.title}</span>
        <span className={styles.badge}>{item.type}</span>
        {item.priority && <span className={styles.badge}>{item.priority}</span>}
        {item.status && <span className={styles['backlog-item-status']}>{item.status}</span>}
      </button>
      {expanded && hasDetails && (
        <div className={styles['backlog-item-body']}>
          {item.description && <p className={styles['backlog-desc']}>{item.description}</p>}
          {item.acceptanceCriteria && item.acceptanceCriteria.length > 0 && (
            <div className={styles['backlog-section']}>
              <div className={styles['backlog-section-label']}>Acceptance criteria</div>
              <ul>
                {item.acceptanceCriteria.map((ac) => (
                  <li key={ac}>{ac}</li>
                ))}
              </ul>
            </div>
          )}
          {item.definitionOfDone && item.definitionOfDone.length > 0 && (
            <div className={styles['backlog-section']}>
              <div className={styles['backlog-section-label']}>Definition of done</div>
              <ul>
                {item.definitionOfDone.map((dod) => (
                  <li key={dod}>{dod}</li>
                ))}
              </ul>
            </div>
          )}
          {item.dependencies && item.dependencies.length > 0 && (
            <div className={styles['backlog-section']}>
              <div className={styles['backlog-section-label']}>Dependencies</div>
              <p>{item.dependencies.join(', ')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const FeatureContextModal: React.FC<FeatureContextModalProps> = ({
  project,
  feature,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<TabId>('prd');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const { data: sessions = [] } = useActiveSessions(project);
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useApexFeatureContext(project, feature.prdId, feature.featureId);

  const readiness = computeFeatureWorkStatus(feature, sessions, sessions);
  const workLabel = formatMyWorkStatusLabel(readiness.state);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (
      e.key !== 'ArrowDown' &&
      e.key !== 'ArrowUp' &&
      e.key !== 'ArrowRight' &&
      e.key !== 'ArrowLeft' &&
      e.key !== 'Home' &&
      e.key !== 'End'
    ) {
      return;
    }
    e.preventDefault();
    let next = index;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = TABS.length - 1;
    setActiveTab(TABS[next].id);
    const tabEl = dialogRef.current?.querySelector<HTMLElement>(`[data-tab-id="${TABS[next].id}"]`);
    tabEl?.focus();
  };

  const tabMeta = (id: TabId): string => {
    if (!data) return '';
    switch (id) {
      case 'prd':
        return data.prdContent ? 'Available' : 'Empty';
      case 'backlog':
        return `${data.backlogItems.length} item${data.backlogItems.length === 1 ? '' : 's'}`;
      case 'design':
        return data.designDocument ? data.designDocument.status : 'Not generated';
      case 'tech':
        return data.designDocument?.techSpecContent
          ? 'Available'
          : data.designDocument
            ? 'Empty'
            : 'Not generated';
      case 'assumptions':
        return data.designDocument?.assumptionsContent
          ? 'Available'
          : data.designDocument
            ? 'Empty'
            : 'Not generated';
      case 'prototype':
        return data.prototype ? data.prototype.status : 'Not generated';
      default:
        return '';
    }
  };

  const renderTabPanel = () => {
    if (isLoading || (isFetching && !data)) {
      return <div className={styles.state}>Loading feature context…</div>;
    }
    if (isError) {
      return (
        <div className={styles.state} role="alert">
          <p>{(error as Error)?.message ?? 'Failed to load feature context'}</p>
          <button
            type="button"
            className={styles['retry-btn']}
            onClick={() => refetch()}
            {...{ 'data-testid': 'feature-context-retry-btn' }}
          >
            Retry
          </button>
        </div>
      );
    }
    if (!data) {
      return <div className={styles.state}>Feature context is unavailable.</div>;
    }

    switch (activeTab) {
      case 'prd':
        if (!data.prdContent) {
          return <div className={styles.empty}>No PRD content is available for this feature.</div>;
        }
        return <MarkdownWithMermaid content={data.prdContent} className={styles.markdown} />;
      case 'backlog':
        if (data.backlogItems.length === 0) {
          return <div className={styles.empty}>No backlog items for this feature.</div>;
        }
        return (
          <div className={styles['backlog-list']}>
            <div className={styles['backlog-summary']}>
              Only work items associated with {feature.featureId} are shown.
            </div>
            {data.backlogItems.map((item) => (
              <BacklogItemCard
                key={item.id}
                item={item}
                {...{ 'data-testid': `feature-context-backlog-item-${item.id}` }}
              />
            ))}
          </div>
        );
      case 'design':
        if (!data.designDocument) {
          return (
            <div className={styles.empty}>Design document has not been generated for this feature.</div>
          );
        }
        if (!data.designDocument.designContent) {
          return <div className={styles.empty}>Design document is empty.</div>;
        }
        return (
          <MarkdownWithMermaid content={data.designDocument.designContent} className={styles.markdown} />
        );
      case 'tech':
        if (!data.designDocument) {
          return <div className={styles.empty}>Tech spec has not been generated for this feature.</div>;
        }
        if (!data.designDocument.techSpecContent) {
          return <div className={styles.empty}>Tech spec is empty.</div>;
        }
        return (
          <MarkdownWithMermaid
            content={data.designDocument.techSpecContent}
            className={styles.markdown}
          />
        );
      case 'assumptions':
        if (!data.designDocument) {
          return (
            <div className={styles.empty}>Assumptions have not been generated for this feature.</div>
          );
        }
        if (!data.designDocument.assumptionsContent) {
          return <div className={styles.empty}>Assumptions document is empty.</div>;
        }
        return (
          <MarkdownWithMermaid
            content={data.designDocument.assumptionsContent}
            className={styles.markdown}
          />
        );
      case 'prototype':
        if (!data.prototype || !data.prototype.mockHtml) {
          return <div className={styles.empty}>Prototype has not been generated for this feature.</div>;
        }
        return (
          <div className={styles['prototype-wrap']}>
            <UiMockPreview mock={prototypeToUiMock(data.prototype)} />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={styles.overlay}
      onClick={onClose}
      {...{ 'data-testid': 'feature-context-modal-overlay' }}
    >
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        {...{ 'data-testid': 'feature-context-modal' }}
      >
        <header className={styles.header}>
          <div className={styles['header-main']}>
            <div className={styles['header-meta']}>
              <span className={styles['feature-id']}>{feature.featureId}</span>
              <span className={styles.badge}>{workLabel}</span>
              <span className={styles.badge}>{feature.featurePriority}</span>
            </div>
            <h2 id={titleId} className={styles.title}>{feature.featureTitle}</h2>
            <p className={styles.subtitle}>
              PRD: {data?.prdTitle ?? feature.prdTitle}
              {' · '}
              Epic: {data?.epicTitle ?? feature.epicTitle}
            </p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className={styles['close-btn']}
            onClick={onClose}
            aria-label="Close"
            {...{ 'data-testid': 'feature-context-close-btn' }}
          >
            Close
          </button>
        </header>

        <div className={styles.body}>
          <div
            className={styles.tabs}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Feature context sections"
            {...{ 'data-testid': 'feature-context-tabs' }}
          >
            {TABS.map((tab, index) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`feature-context-tab-${tab.id}`}
                  data-tab-id={tab.id}
                  aria-selected={selected}
                  aria-controls={`feature-context-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={`${styles.tab}${selected ? ` ${styles['tab-active']}` : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, index)}
                  {...{ 'data-testid': `feature-context-tab-${tab.id}` }}
                >
                  <span className={styles['tab-label']}>{tab.label}</span>
                  {data && <span className={styles['tab-meta']}>{tabMeta(tab.id)}</span>}
                </button>
              );
            })}
          </div>

          <div
            className={styles.panel}
            role="tabpanel"
            id={`feature-context-panel-${activeTab}`}
            aria-labelledby={`feature-context-tab-${activeTab}`}
            {...{ 'data-testid': 'feature-context-panel' }}
          >
            {renderTabPanel()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FeatureContextModal;
