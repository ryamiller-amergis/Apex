import React, {
  useCallback,
  useMemo,
  useState,
} from 'react';
import type {
  LinkCandidate,
  LinkCandidateType,
} from '../../shared/types/interviewLinks';
import {
  LINK_CANDIDATE_DEFAULT_PAGE_SIZE,
  LINKED_CONTEXT_CAPACITY,
} from '../../shared/types/interviewLinks';
import {
  useAddAdrLink,
  useAddDesignModuleLink,
  useLinkCandidates,
  useLinkedContext,
  useRemoveAdrLink,
  useRemoveDesignModuleLink,
} from '../hooks/useLinkedContext';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import styles from './LinkedContextPicker.module.css';

export type LinkedContextPickerMode = 'staged' | 'persisted';

export type StagedLinkedContextSelection = {
  type: LinkCandidateType;
  id: string;
  label: string;
};

export interface LinkedContextPickerProps {
  mode: LinkedContextPickerMode;
  project: string;
  interviewId?: string;
  canManage: boolean;
  interviewStatus?: string;
  stagedSelections?: StagedLinkedContextSelection[];
  onStagedSelectionsChange?: (
    selections: StagedLinkedContextSelection[],
  ) => void;
  initialErrorText?: string;
  onClose?: () => void;
}

type DisplayLink = StagedLinkedContextSelection & {
  stale: boolean;
};

function candidateLabel(candidate: LinkCandidate): string {
  return candidate.type === 'adr' ? candidate.title : candidate.name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to update linked context.';
}

interface LinkedContextLinkRowProps {
  link: DisplayLink;
  canRemove: boolean;
  isBusy: boolean;
  onRemove: (link: DisplayLink) => void;
  'data-testid'?: string;
}

export const LinkedContextLinkRow: React.FC<LinkedContextLinkRowProps> = ({
  link,
  canRemove,
  isBusy,
  onRemove,
}) => (
  <li
    className={styles['link-row']}
    {...{
      'data-testid': `linked-context-link-${link.type}-${link.id}`,
    }}
  >
    <div className={styles['link-details']}>
      <span className={styles['type-label']}>
        {link.type === 'adr' ? 'ADR' : 'Design Module'}
      </span>
      <span className={styles['item-label']}>{link.label}</span>
      {link.stale && (
        <span
          className={styles['stale-badge']}
          aria-label="No longer accepted"
          {...{
            'data-testid': `linked-context-stale-badge-${link.id}`,
          }}
        >
          No longer accepted
        </span>
      )}
    </div>
    {canRemove && (
      <button
        type="button"
        className={styles['secondary-button']}
        disabled={isBusy}
        aria-label={`Remove ${link.label}`}
        onClick={() => onRemove(link)}
        {...{
          'data-testid': `linked-context-remove-${link.type}-${link.id}`,
        }}
      >
        Remove
      </button>
    )}
  </li>
);

interface LinkedContextCandidateListProps {
  candidates: LinkCandidate[];
  canAdd: boolean;
  atCapacity: boolean;
  isBusy: boolean;
  isLoading: boolean;
  error: Error | null;
  onAdd: (candidate: LinkCandidate) => void;
  'data-testid'?: string;
}

export const LinkedContextCandidateList: React.FC<
  LinkedContextCandidateListProps
> = ({
  candidates,
  canAdd,
  atCapacity,
  isBusy,
  isLoading,
  error,
  onAdd,
}) => {
  if (isLoading) {
    return (
      <p
        className={styles['state-message']}
        role="status"
        {...{ 'data-testid': 'linked-context-candidates-loading' }}
      >
        Loading candidates…
      </p>
    );
  }

  if (error) return null;

  if (candidates.length === 0) {
    return (
      <p
        className={styles['state-message']}
        {...{ 'data-testid': 'linked-context-candidates-empty' }}
      >
        No matching candidates.
      </p>
    );
  }

  return (
    <ul
      className={styles['candidate-list']}
      {...{ 'data-testid': 'linked-context-candidate-list' }}
    >
      {candidates.map((candidate) => {
        const label = candidateLabel(candidate);
        return (
          <li
            key={`${candidate.type}-${candidate.id}`}
            className={styles['candidate-row']}
            {...{
              'data-testid': `linked-context-candidate-${candidate.type}-${candidate.id}`,
            }}
          >
            <div className={styles['link-details']}>
              <span className={styles['type-label']}>
                {candidate.type === 'adr' ? 'ADR' : 'Design Module'}
              </span>
              <span className={styles['item-label']}>{label}</span>
            </div>
            {canAdd && (
              <button
                type="button"
                className={styles['primary-button']}
                disabled={atCapacity || isBusy}
                aria-label={`Add ${label}`}
                aria-describedby={
                  atCapacity ? 'linked-context-capacity-message' : undefined
                }
                onClick={() => onAdd(candidate)}
                {...{
                  'data-testid': `linked-context-add-${candidate.type}-${candidate.id}`,
                }}
              >
                Add
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
};

export const LinkedContextPicker: React.FC<LinkedContextPickerProps> = ({
  mode,
  project,
  interviewId,
  canManage,
  interviewStatus,
  stagedSelections = [],
  onStagedSelectionsChange,
  initialErrorText,
  onClose,
}) => {
  const [search, setSearch] = useState('');
  const [candidateType, setCandidateType] =
    useState<LinkCandidateType>('adr');
  const [offset, setOffset] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [initialError, setInitialError] = useState(initialErrorText ?? null);
  const [statusText, setStatusText] = useState('');
  // data-testid-exempt -- TypeScript generic, not JSX.
  const [undoLink, setUndoLink] = useState<DisplayLink | null>(null);

  const debouncedSearch = useDebouncedValue(search, 300);
  const persistedInterviewId =
    mode === 'persisted' ? interviewId ?? null : null;
  const linkedContextQuery = useLinkedContext(persistedInterviewId);
  const candidatesQuery = useLinkCandidates(project, persistedInterviewId, {
    type: candidateType,
    search: debouncedSearch,
    offset,
    limit: LINK_CANDIDATE_DEFAULT_PAGE_SIZE,
  });
  const addAdr = useAddAdrLink(interviewId ?? '', project);
  const addDesignModule = useAddDesignModuleLink(interviewId ?? '', project);
  const removeAdr = useRemoveAdrLink(interviewId ?? '', project);
  const removeDesignModule = useRemoveDesignModuleLink(
    interviewId ?? '',
    project,
  );

  // data-testid-exempt -- TypeScript generic, not JSX.
  const displayLinks = useMemo<DisplayLink[]>(() => {
    if (mode === 'staged') {
      return stagedSelections.map((selection) => ({
        ...selection,
        stale: false,
      }));
    }

    const linkedContext = linkedContextQuery.data;
    if (!linkedContext) return [];
    return [
      ...linkedContext.adrLinks.map((link) => ({
        type: 'adr' as const,
        id: link.adrId,
        label: link.title,
        stale: Boolean(link.staleReason) || !link.isAccepted,
      })),
      ...linkedContext.designModuleLinks.map((link) => ({
        type: 'design-module' as const,
        id: link.designModuleId,
        label: link.name,
        stale: false,
      })),
    ];
  }, [linkedContextQuery.data, mode, stagedSelections]);

  const linkedIds = useMemo(
    () => new Set(displayLinks.map((link) => `${link.type}:${link.id}`)),
    [displayLinks],
  );
  const visibleCandidates = useMemo(
    () =>
      (candidatesQuery.data?.items ?? []).filter(
        (candidate) => !linkedIds.has(`${candidate.type}:${candidate.id}`),
      ),
    [candidatesQuery.data?.items, linkedIds],
  );

  const linkCount =
    mode === 'persisted'
      ? linkedContextQuery.data?.count ?? displayLinks.length
      : stagedSelections.length;
  const atCapacity = linkCount >= LINKED_CONTEXT_CAPACITY;
  const canEdit =
    canManage &&
    (mode === 'staged' || interviewStatus === 'in_progress') &&
    (mode === 'persisted' || Boolean(onStagedSelectionsChange));
  const isBusy =
    addAdr.isPending ||
    addDesignModule.isPending ||
    removeAdr.isPending ||
    removeDesignModule.isPending;
  const queryError =
    linkedContextQuery.error?.message ?? candidatesQuery.error?.message;
  const displayedError = actionError ?? initialError ?? queryError;
  const totalCandidates = candidatesQuery.data?.total ?? 0;
  const hasPreviousPage = offset > 0;
  const hasNextPage =
    offset + LINK_CANDIDATE_DEFAULT_PAGE_SIZE < totalCandidates;

  const handleTypeChange = useCallback((type: LinkCandidateType) => {
    setCandidateType(type);
    setOffset(0);
  }, []);

  const handleAdd = useCallback(
    async (candidate: LinkCandidate) => {
      if (!canEdit || atCapacity || linkedIds.has(`${candidate.type}:${candidate.id}`)) {
        return;
      }

      const label = candidateLabel(candidate);
      setActionError(null);
      setInitialError(null);
      setUndoLink(null);
      try {
        if (mode === 'staged') {
          onStagedSelectionsChange?.([
            ...stagedSelections,
            { type: candidate.type, id: candidate.id, label },
          ]);
          setStatusText(`Added ${label}.`);
          return;
        }

        if (candidate.type === 'adr') {
          await addAdr.mutateAsync({ adrId: candidate.id });
        } else {
          await addDesignModule.mutateAsync({
            designModuleId: candidate.id,
          });
        }
        setStatusText(`Linked ${label}.`);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [
      addAdr,
      addDesignModule,
      atCapacity,
      canEdit,
      linkedIds,
      mode,
      onStagedSelectionsChange,
      stagedSelections,
    ],
  );

  const handleRemove = useCallback(
    async (link: DisplayLink) => {
      if (!canEdit) return;
      setActionError(null);
      setInitialError(null);
      setUndoLink(null);
      try {
        if (mode === 'staged') {
          onStagedSelectionsChange?.(
            stagedSelections.filter(
              (selection) =>
                selection.type !== link.type || selection.id !== link.id,
            ),
          );
          setStatusText(`Removed ${link.label}.`);
          return;
        }

        if (link.type === 'adr') {
          await removeAdr.mutateAsync(link.id);
        } else {
          await removeDesignModule.mutateAsync(link.id);
        }
        setUndoLink(link);
        setStatusText(`Removed ${link.label}. Undo is available.`);
      } catch (error) {
        setActionError(errorMessage(error));
      }
    },
    [
      canEdit,
      mode,
      onStagedSelectionsChange,
      removeAdr,
      removeDesignModule,
      stagedSelections,
    ],
  );

  const handleUndo = useCallback(async () => {
    if (!undoLink || mode !== 'persisted') return;
    setActionError(null);
    setInitialError(null);
    try {
      if (undoLink.type === 'adr') {
        await addAdr.mutateAsync({ adrId: undoLink.id });
      } else {
        await addDesignModule.mutateAsync({
          designModuleId: undoLink.id,
        });
      }
      setStatusText(`Restored ${undoLink.label}.`);
      setUndoLink(null);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }, [addAdr, addDesignModule, mode, undoLink]);

  const handleRetry = useCallback(() => {
    setActionError(null);
    setInitialError(null);
    if (mode === 'persisted') void linkedContextQuery.refetch();
    void candidatesQuery.refetch();
  }, [candidatesQuery, linkedContextQuery, mode]);

  return (
    <section
      className={styles.picker}
      aria-label="Linked context"
      {...{ 'data-testid': 'linked-context-picker' }}
    >
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Linked Context</h2>
          <p className={styles.description}>
            Choose accepted ADRs and Design Modules to ground the Interview.
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            className={styles['secondary-button']}
            aria-label="Close linked context"
            onClick={onClose}
            {...{ 'data-testid': 'linked-context-close' }}
          >
            Close
          </button>
        )}
      </div>

      {!canEdit && (
        <p
          className={styles['read-only']}
          {...{ 'data-testid': 'linked-context-read-only' }}
        >
          Linked context is read-only.
        </p>
      )}

      {linkedContextQuery.isLoading && mode === 'persisted' && (
        <p
          className={styles['state-message']}
          role="status"
          {...{ 'data-testid': 'linked-context-loading' }}
        >
          Loading linked context…
        </p>
      )}

      {displayedError && (
        <div
          className={styles.error}
          role="status"
          aria-live="polite"
          {...{ 'data-testid': 'linked-context-error' }}
        >
          <span>{displayedError}</span>
          {queryError && (
            <button
              type="button"
              className={styles['secondary-button']}
              onClick={handleRetry}
              {...{ 'data-testid': 'linked-context-retry' }}
            >
              Retry
            </button>
          )}
          {!actionError && !queryError && initialError && (
            <button
              type="button"
              className={styles['secondary-button']}
              onClick={() => setInitialError(null)}
              {...{ 'data-testid': 'linked-context-dismiss-error' }}
            >
              Dismiss
            </button>
          )}
        </div>
      )}

      <div
        className={styles.status}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        {...{ 'data-testid': 'linked-context-status' }}
      >
        {statusText}
      </div>

      <div
        id="linked-context-capacity-message"
        className={atCapacity ? styles.capacity : styles['capacity-available']}
        role="status"
        aria-live="polite"
        {...{ 'data-testid': 'linked-context-capacity' }}
      >
        {atCapacity
          ? `Remove a linked item to add another (${linkCount} of ${LINKED_CONTEXT_CAPACITY}).`
          : `${linkCount} of ${LINKED_CONTEXT_CAPACITY} linked.`}
      </div>

      <section
        className={styles.section}
        aria-labelledby="linked-context-current-heading"
      >
        <h3 id="linked-context-current-heading" className={styles['section-title']}>
          Current links
        </h3>
        {!linkedContextQuery.isLoading && displayLinks.length === 0 ? (
          <p
            className={styles['state-message']}
            {...{ 'data-testid': 'linked-context-empty' }}
          >
            No linked context yet.
          </p>
        ) : (
          <ul className={styles['link-list']}>
            {displayLinks.map((link) => (
              <LinkedContextLinkRow
                key={`${link.type}-${link.id}`}
                link={link}
                canRemove={canEdit}
                isBusy={isBusy}
                onRemove={handleRemove}
                {...{
                  'data-testid': `linked-context-link-row-${link.type}-${link.id}`,
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {undoLink && mode === 'persisted' && (
        <div
          className={styles.undo}
          role="status"
          aria-live="polite"
          {...{ 'data-testid': 'linked-context-undo-notice' }}
        >
          <span>{undoLink.label} removed.</span>
          <button
            type="button"
            className={styles['secondary-button']}
            disabled={isBusy}
            onClick={() => void handleUndo()}
            {...{ 'data-testid': 'linked-context-undo' }}
          >
            Undo
          </button>
        </div>
      )}

      <section
        className={styles.section}
        aria-labelledby="linked-context-candidates-heading"
      >
        <h3
          id="linked-context-candidates-heading"
          className={styles['section-title']}
        >
          Available context
        </h3>

        <div className={styles.filters}>
          <div
            className={styles['filter-buttons']}
            role="group"
            aria-label="Candidate type"
          >
            <button
              type="button"
              className={
                candidateType === 'adr'
                  ? styles['filter-button-active']
                  : styles['filter-button']
              }
              aria-pressed={candidateType === 'adr'}
              onClick={() => handleTypeChange('adr')}
              {...{ 'data-testid': 'linked-context-filter-adr' }}
            >
              ADRs
            </button>
            <button
              type="button"
              className={
                candidateType === 'design-module'
                  ? styles['filter-button-active']
                  : styles['filter-button']
              }
              aria-pressed={candidateType === 'design-module'}
              onClick={() => handleTypeChange('design-module')}
              {...{
                'data-testid': 'linked-context-filter-design-module',
              }}
            >
              Design Modules
            </button>
          </div>
          <label className={styles['search-label']} htmlFor="linked-context-search">
            Search
            <input
              id="linked-context-search"
              type="search"
              className={styles.search}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
              placeholder="Search available context"
              {...{ 'data-testid': 'linked-context-search' }}
            />
          </label>
        </div>

        <LinkedContextCandidateList
          candidates={visibleCandidates}
          canAdd={canEdit}
          atCapacity={atCapacity}
          isBusy={isBusy}
          isLoading={candidatesQuery.isLoading}
          error={candidatesQuery.error}
          onAdd={(candidate) => void handleAdd(candidate)}
          {...{ 'data-testid': 'linked-context-candidate-list-control' }}
        />

        {totalCandidates > LINK_CANDIDATE_DEFAULT_PAGE_SIZE && (
          <nav
            className={styles.pagination}
            aria-label="Linked context candidates pagination"
            {...{ 'data-testid': 'linked-context-pagination' }}
          >
            <button
              type="button"
              className={styles['secondary-button']}
              disabled={!hasPreviousPage}
              onClick={() =>
                setOffset((current) =>
                  Math.max(
                    0,
                    current - LINK_CANDIDATE_DEFAULT_PAGE_SIZE,
                  ),
                )
              }
              {...{ 'data-testid': 'linked-context-previous-page' }}
            >
              Previous
            </button>
            <span>
              {offset + 1}–
              {Math.min(
                offset + LINK_CANDIDATE_DEFAULT_PAGE_SIZE,
                totalCandidates,
              )}{' '}
              of {totalCandidates}
            </span>
            <button
              type="button"
              className={styles['secondary-button']}
              disabled={!hasNextPage}
              onClick={() =>
                setOffset(
                  (current) =>
                    current + LINK_CANDIDATE_DEFAULT_PAGE_SIZE,
                )
              }
              {...{ 'data-testid': 'linked-context-next-page' }}
            >
              Next
            </button>
          </nav>
        )}
      </section>
    </section>
  );
};

export default LinkedContextPicker;
