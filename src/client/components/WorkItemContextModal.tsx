import React, { useEffect, useId, useRef } from 'react';
import { useMyWorkItemContext } from '../hooks/useDevWorkbench';
import type { MyWorkItemContextChild } from '../../shared/types/devWorkbench';
import styles from './WorkItemContextModal.module.css';

interface WorkItemContextModalProps {
  project: string;
  workItemId: number;
  title: string;
  onClose: () => void;
}

const ContextSection: React.FC<{ title: string; text: string; testId: string }> = ({
  title,
  text,
  testId,
}) => (
  <section className={styles.section} {...{ 'data-testid': testId }}>
    <h3>{title}</h3>
    <p className={text ? styles.copy : styles.empty}>{text || 'None'}</p>
  </section>
);

const ChildRow: React.FC<{ child: MyWorkItemContextChild }> = ({ child }) => (
  <li {...{ 'data-testid': `my-work-item-context-child-${child.id}` }}>
    <span className={styles['child-id']}>#{child.id}</span>
    <span className={styles['child-type']}>{child.workItemType}</span>
    <span className={styles['child-title']}>{child.title}</span>
    <span className={styles['child-state']}>{child.state}</span>
  </li>
);

export const WorkItemContextModal: React.FC<WorkItemContextModalProps> = ({
  project,
  workItemId,
  title,
  onClose,
}) => {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const { data, isLoading, isError, error, refetch, isFetching } = useMyWorkItemContext(
    project,
    workItemId,
  );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [onClose]);

  const heading = data?.title || title;

  return (
    <div
      className={styles.overlay}
      onClick={onClose}
      {...{ 'data-testid': 'my-work-item-context-overlay' }}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        {...{ 'data-testid': 'my-work-item-context-modal' }}
      >
        <header className={styles.header}>
          <div className={styles['header-main']}>
            <div className={styles['header-meta']}>
              <span className={styles['item-id']}>#{workItemId}</span>
              {data && <span className={styles.badge}>{data.workItemType}</span>}
              {data && <span className={styles.badge}>{data.state}</span>}
            </div>
            <h2 id={titleId} className={styles.title}>{heading}</h2>
            <p className={styles.subtitle}>View context</p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className={styles['close-btn']}
            onClick={onClose}
            aria-label="Close"
            {...{ 'data-testid': 'my-work-item-context-close' }}
          >
            Close
          </button>
        </header>

        <div className={styles.body}>
          {isLoading || (isFetching && !data) ? (
            <p className={styles.status} role="status">Loading work item context…</p>
          ) : isError ? (
            <div className={styles.status} role="alert">
              <p>{error instanceof Error ? error.message : 'Failed to load work item context'}</p>
              <button
                type="button"
                className={styles['retry-btn']}
                onClick={() => refetch()}
                {...{ 'data-testid': 'my-work-item-context-retry' }}
              >
                Retry
              </button>
            </div>
          ) : data ? (
            <>
              <ContextSection
                title="Description"
                text={data.description}
                testId="my-work-item-context-description"
              />
              <ContextSection
                title="Acceptance criteria"
                text={data.acceptanceCriteria}
                testId="my-work-item-context-acceptance"
              />
              {data.reproSteps ? (
                <ContextSection
                  title="Repro steps"
                  text={data.reproSteps}
                  testId="my-work-item-context-repro"
                />
              ) : null}
              {data.design ? (
                <ContextSection
                  title="Design"
                  text={data.design}
                  testId="my-work-item-context-design"
                />
              ) : null}
              <section
                className={styles.section}
                {...{ 'data-testid': 'my-work-item-context-children' }}
              >
                <h3>Child work items</h3>
                {data.children.length === 0 ? (
                  <p className={styles.empty}>No child work items.</p>
                ) : (
                  <ul className={styles.children}>
                    {data.children.map((child) => (
                      <ChildRow key={child.id} child={child} />
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <p className={styles.status}>Work item context is unavailable.</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default WorkItemContextModal;
