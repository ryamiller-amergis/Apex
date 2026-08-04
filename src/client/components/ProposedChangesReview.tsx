import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { DiffView } from './DiffView';
import { ChangeReviewWizard } from './ChangeReviewWizard';
import {
  useRejectProposedPrd,
  useApplyProposedPrdSelective,
  useRegenerateProposedPrdSection,
  useUpdatePrdContent,
  useUpdatePrdBacklog,
} from '../hooks/useInterviews';
import { computeBacklogDiff, countChanges } from '../utils/backlogDiff';
import type { ItemChange, FieldChange, ItemDetail, ChangeKind } from '../utils/backlogDiff';
import {
  buildPrdChangeUnits,
  mergePrdProposalFromUnits,
  reapplyDecisions,
  countDecisions,
} from '../utils/changeReview';
import type { ChangeUnit, ChangeDecision, BacklogItemMeta } from '../utils/changeReview';
import styles from './ProposedChangesReview.module.css';

export interface ProposedChangesReviewProps {
  prdId: string;
  /** Old/live text for proposed mode; fix-baseline content for fix-baseline mode. */
  currentContent: string;
  currentBacklogJson?: unknown;
  /** Proposed text for proposed mode; current live text for fix-baseline mode. */
  proposedContent?: string | null;
  proposedBacklogJson?: unknown;
  /**
   * `proposed` — staged proposed_* columns (comment / assistant fixes).
   * `fix-baseline` — validation/coverage Fix-with-Apex (baseline vs live).
   */
  reviewMode?: 'proposed' | 'fix-baseline';
  /** After selective merge is written live (fix-baseline Finish). */
  onAcceptAndRevalidate?: () => void | Promise<void>;
  /** Reject all / revert in fix-baseline mode. */
  onRejectAll?: () => void | Promise<void>;
  /**
   * When true, the yellow banner is not rendered — parent owns the CTA strip.
   * Modal review still works via `modalOpen` / `onModalOpenChange`.
   */
  hideBanner?: boolean;
  /** Controlled modal visibility (used with hideBanner / unified strip). */
  modalOpen?: boolean;
  onModalOpenChange?: (open: boolean) => void;
  /** Fires whenever review progress changes (for parent strip chips). */
  onReviewProgress?: (progress: {
    approved: number;
    rejected: number;
    pending: number;
    total: number;
  }) => void;
  /** When true with hideBanner, skip auto-opening the modal on mount. */
  deferAutoOpen?: boolean;
}

/* ── Detail list (for added/removed items) ───────────────────────────────── */

const DetailList: React.FC<{ details: ItemDetail[]; kind: ChangeKind }> = ({ details, kind }) => {
  if (details.length === 0) return null;
  const isRemoved = kind === 'removed';
  return (
    <dl className={`${styles.detailList} ${isRemoved ? styles.detailListRemoved : ''}`}>
      {details.map((d) => (
        <div key={d.label} className={styles.detailRow}>
          <dt className={styles.detailLabel}>{d.label}</dt>
          <dd className={styles.detailValue}>
            {d.items ? (
              <ul className={styles.detailBullets}>
                {d.items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            ) : (
              d.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
};

/* ── Backlog change card (flat — no nesting) ─────────────────────────────── */

const ChangeCard: React.FC<{ change: ItemChange; defaultOpen?: boolean }> = ({ change, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const kindClass =
    change.kind === 'added' ? styles.changeCardAdded :
    change.kind === 'removed' ? styles.changeCardRemoved :
    styles.changeCardModified;
  const badgeClass =
    change.kind === 'added' ? styles.kindAdded :
    change.kind === 'removed' ? styles.kindRemoved :
    styles.kindModified;
  const kindLabel = change.kind === 'added' ? 'Added' : change.kind === 'removed' ? 'Removed' : 'Modified';
  const hasBody = change.fields.length > 0 || change.details.length > 0;

  return (
    <div className={`${styles.changeCard} ${kindClass}`}>
      <div
        className={styles.changeCardHeader}
        onClick={() => hasBody && setOpen((v) => !v)}
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
      >
        {hasBody && (
          <svg
            className={`${styles.changeCardChevron} ${open ? styles.changeCardChevronOpen : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        )}
        <span className={`${styles.changeKindBadge} ${badgeClass}`}>{kindLabel}</span>
        <span className={styles.changeCardType}>{change.itemType}</span>
        <span className={styles.changeCardTitle}>{change.title}</span>
      </div>

      {change.parentPath && (
        <div className={styles.breadcrumb}>{change.parentPath}</div>
      )}

      {hasBody && (
        <div className={open ? styles.changeCardBody : styles.changeCardBodyHidden}>
          {change.details.length > 0 && (
            <DetailList details={change.details} kind={change.kind} />
          )}
          {change.fields.length > 0 && <FieldChangesTable fields={change.fields} />}
        </div>
      )}
    </div>
  );
};

/* ── Field changes (for modified items) ──────────────────────────────────── */

const FieldChangesTable: React.FC<{ fields: FieldChange[] }> = ({ fields }) => (
  <div className={styles.fieldChangesWrap}>
    {fields.map((f) => (
      <div key={f.field} className={styles.fieldChangeRow}>
        <div className={styles.fieldChangeLabel}>{f.field}</div>
        <div className={styles.fieldChangeValues}>
          <div className={styles.fieldOldWrap}>
            <span className={styles.fieldArrowLabel}>Was</span>
            <span className={styles.fieldOld}>{f.oldValue}</span>
          </div>
          <div className={styles.fieldNewWrap}>
            <span className={styles.fieldArrowLabel}>Now</span>
            <span className={styles.fieldNew}>{f.newValue}</span>
          </div>
          {f.addedItems && f.addedItems.length > 0 && (
            <div className={styles.arrayDelta}>
              <span className={styles.arrayDeltaLabel}>Added:</span>
              <ul className={styles.arrayDeltaList}>
                {f.addedItems.map((item, i) => (
                  <li key={i} className={styles.arrayDeltaAdded}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {f.removedItems && f.removedItems.length > 0 && (
            <div className={styles.arrayDelta}>
              <span className={styles.arrayDeltaLabel}>Removed:</span>
              <ul className={styles.arrayDeltaList}>
                {f.removedItems.map((item, i) => (
                  <li key={i} className={styles.arrayDeltaRemoved}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    ))}
  </div>
);

/* ── Backlog changes view ────────────────────────────────────────────────── */

const BacklogChangesView: React.FC<{ oldJson: unknown; newJson: unknown }> = ({ oldJson, newJson }) => {
  const changes = useMemo(() => computeBacklogDiff(oldJson, newJson), [oldJson, newJson]);
  const counts = useMemo(() => countChanges(changes), [changes]);
  const total = counts.added + counts.removed + counts.modified;

  if (changes.length === 0) {
    return <div className={styles.noBacklogChanges}>No structural backlog changes detected.</div>;
  }

  return (
    <div className={styles.backlogDiff}>
      <div className={styles.changeSummary}>
        {counts.added > 0 && (
          <span className={styles.changeSumStat}>
            <span className={styles.addedDot} />
            {counts.added} added
          </span>
        )}
        {counts.modified > 0 && (
          <span className={styles.changeSumStat}>
            <span className={styles.modifiedDot} />
            {counts.modified} modified
          </span>
        )}
        {counts.removed > 0 && (
          <span className={styles.changeSumStat}>
            <span className={styles.removedDot} />
            {counts.removed} removed
          </span>
        )}
        <span style={{ color: 'var(--text-muted)' }}>({total} total)</span>
      </div>
      {changes.map((change, i) => (
        <ChangeCard key={`${change.kind}-${change.title}-${i}`} change={change} defaultOpen={changes.length <= 5} />
      ))}
    </div>
  );
};

/* ── Main component ──────────────────────────────────────────────────────── */

export const ProposedChangesReview: React.FC<ProposedChangesReviewProps> = ({
  prdId,
  currentContent,
  currentBacklogJson,
  proposedContent,
  proposedBacklogJson,
  reviewMode = 'proposed',
  onAcceptAndRevalidate,
  onRejectAll,
  hideBanner = false,
  modalOpen: controlledModalOpen,
  onModalOpenChange,
  onReviewProgress,
  deferAutoOpen = false,
}) => {
  const isFixBaseline = reviewMode === 'fix-baseline';
  const isControlled = controlledModalOpen !== undefined;
  const [expanded, setExpanded] = useState(false);
  const [internalModalOpen, setInternalModalOpen] = useState(
    isFixBaseline && !hideBanner && !deferAutoOpen,
  );
  const modalOpen = isControlled ? controlledModalOpen : internalModalOpen;
  const setModalOpen = useCallback(
    (open: boolean) => {
      if (!isControlled) setInternalModalOpen(open);
      onModalOpenChange?.(open);
    },
    [isControlled, onModalOpenChange],
  );
  const [reviewStarted, setReviewStarted] = useState(
    isFixBaseline && !hideBanner && !deferAutoOpen,
  );
  const [units, setUnits] = useState<ChangeUnit[]>([]);
  const [baselineApplying, setBaselineApplying] = useState(false);
  const lastRegeneratedUnitIdRef = useRef<string | undefined>(undefined);
  const didAutoOpenRef = useRef(false);

  const rejectMutation = useRejectProposedPrd(prdId);
  const selectiveApply = useApplyProposedPrdSelective(prdId);
  const regenerateMutation = useRegenerateProposedPrdSection(prdId);
  const updateContent = useUpdatePrdContent();
  const updateBacklog = useUpdatePrdBacklog();

  const builtUnits = useMemo(
    () =>
      buildPrdChangeUnits(
        { content: currentContent, backlog: currentBacklogJson },
        { content: proposedContent, backlog: proposedBacklogJson },
      ),
    [currentContent, currentBacklogJson, proposedContent, proposedBacklogJson],
  );

  // Auto-open modal once when fix-baseline mounts with reviewable units
  // (skipped when parent owns the CTA strip via hideBanner/deferAutoOpen).
  useEffect(() => {
    if (!isFixBaseline || hideBanner || deferAutoOpen || didAutoOpenRef.current) return;
    if (builtUnits.length === 0) return;
    didAutoOpenRef.current = true;
    setUnits(builtUnits);
    setReviewStarted(true);
    setModalOpen(true);
  }, [isFixBaseline, builtUnits, hideBanner, deferAutoOpen, setModalOpen]);

  // When parent opens controlled modal, ensure units are ready
  useEffect(() => {
    if (!isControlled || !modalOpen) return;
    setReviewStarted(true);
    setUnits((prior) => (prior.length > 0 ? prior : builtUnits));
  }, [isControlled, modalOpen, builtUnits]);

  // Rebuild units when proposed/live content changes (e.g. after regenerate), preserving decisions
  useEffect(() => {
    const regeneratedId = lastRegeneratedUnitIdRef.current;
    setUnits((prior) => {
      if (!reviewStarted || prior.length === 0) return builtUnits;
      return reapplyDecisions(builtUnits, prior, regeneratedId);
    });
    lastRegeneratedUnitIdRef.current = undefined;
  }, [builtUnits, reviewStarted]);

  const activeUnits = units.length > 0 ? units : builtUnits;
  const decisionCounts = countDecisions(activeUnits);

  useEffect(() => {
    onReviewProgress?.({
      ...decisionCounts,
      total: activeUnits.length,
    });
  }, [
    decisionCounts.approved,
    decisionCounts.rejected,
    decisionCounts.pending,
    activeUnits.length,
    onReviewProgress,
  ]);

  const handleDecision = useCallback((unitId: string, decision: Exclude<ChangeDecision, 'pending'>) => {
    setUnits((prev) => prev.map((u) => (u.id === unitId ? { ...u, decision } : u)));
  }, []);

  const handleRegenerate = useCallback(
    async (unitId: string, feedback: string) => {
      const unit = units.find((u) => u.id === unitId);
      if (!unit) return;

      const section = unit.kind === 'markdown-hunk' ? 'content' : 'backlog';
      const itemPath =
        unit.kind === 'backlog-item' ? (unit.meta as BacklogItemMeta).itemPath : undefined;

      lastRegeneratedUnitIdRef.current = unitId;
      await regenerateMutation.mutateAsync({
        section,
        oldText: unit.oldText,
        newText: unit.newText,
        feedback,
        itemPath,
      });

      setUnits((prev) =>
        prev.map((u) =>
          u.id === unitId ? { ...u, decision: 'pending', feedback } : u,
        ),
      );
    },
    [units, regenerateMutation],
  );

  const handleFinish = useCallback(
    async (finalUnits: ChangeUnit[]) => {
      const merged = mergePrdProposalFromUnits(
        { content: currentContent, backlog: currentBacklogJson },
        { content: proposedContent, backlog: proposedBacklogJson },
        finalUnits,
      );

      if (isFixBaseline) {
        setBaselineApplying(true);
        try {
          if (merged.content !== undefined) {
            await updateContent.mutateAsync({ prdId, content: merged.content });
          }
          if (merged.backlogJson !== undefined) {
            await updateBacklog.mutateAsync({ prdId, backlogData: merged.backlogJson });
          }
          if (onAcceptAndRevalidate) {
            await onAcceptAndRevalidate();
          }
          setModalOpen(false);
          setReviewStarted(false);
        } finally {
          setBaselineApplying(false);
        }
        return;
      }

      await selectiveApply.mutateAsync(merged);
      setModalOpen(false);
      setReviewStarted(false);
    },
    [
      currentContent,
      currentBacklogJson,
      proposedContent,
      proposedBacklogJson,
      selectiveApply,
      isFixBaseline,
      updateContent,
      updateBacklog,
      prdId,
      onAcceptAndRevalidate,
      setModalOpen,
    ],
  );

  const handleRejectAll = useCallback(async () => {
    if (isFixBaseline) {
      if (onRejectAll) await onRejectAll();
      return;
    }
    rejectMutation.mutate();
  }, [isFixBaseline, onRejectAll, rejectMutation]);

  if (!isFixBaseline && proposedContent == null && proposedBacklogJson == null) {
    return null;
  }

  if (isFixBaseline && builtUnits.length === 0) {
    return null;
  }

  const hasContentChanges =
    proposedContent != null && proposedContent !== currentContent;
  const hasBacklogChanges =
    proposedBacklogJson != null &&
    JSON.stringify(proposedBacklogJson) !== JSON.stringify(currentBacklogJson ?? null);
  const busy =
    rejectMutation.isPending
    || selectiveApply.isPending
    || regenerateMutation.isPending
    || baselineApplying
    || updateContent.isPending
    || updateBacklog.isPending;

  const openWizard = () => {
    if (!reviewStarted || units.length === 0) {
      setUnits(builtUnits);
    }
    setReviewStarted(true);
    setModalOpen(true);
    setExpanded(false);
  };

  const minimizeWizard = () => {
    setModalOpen(false);
  };

  const modalTitle = isFixBaseline
    ? 'Review Apex fixes'
    : 'Review proposed changes';

  const modalPortal =
    reviewStarted
    && typeof document !== 'undefined'
    && createPortal(
      <div
        className={modalOpen ? styles.modalOverlay : styles.modalOverlayHidden}
        role="dialog"
        aria-modal={modalOpen ? 'true' : undefined}
        aria-hidden={!modalOpen}
        aria-labelledby="change-review-modal-title"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy) minimizeWizard();
        }}
      >
        <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
          <div className={styles.modalHeader}>
            <h2 id="change-review-modal-title" className={styles.modalTitle}>
              {modalTitle}
            </h2>
            <div className={styles.modalHeaderActions}>
              <button
                type="button"
                className={styles.minimizeBtn}
                onClick={minimizeWizard}
                disabled={busy}
              >
                Minimize
              </button>
            </div>
          </div>
          <div className={styles.modalBody}>
            <ChangeReviewWizard
              units={activeUnits}
              onDecision={handleDecision}
              onRequestRegenerate={handleRegenerate}
              onFinish={handleFinish}
              onCancel={minimizeWizard}
              cancelLabel="Minimize"
              isRegenerating={regenerateMutation.isPending}
              isApplying={selectiveApply.isPending || baselineApplying}
            />
          </div>
        </div>
      </div>,
      document.body,
    );

  if (hideBanner) {
    return <>{modalPortal}</>;
  }

  return (
    <div className={styles.banner}>
      <div className={styles.bannerTop}>
        <div className={styles.bannerLeft}>
          <svg
            className={styles.bannerIcon}
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="10" cy="10" r="9" />
            <path d="M10 6v4M10 14h.01" />
          </svg>
          <div>
            <span className={styles.bannerTitle}>
              {isFixBaseline
                ? 'Apex has applied fixes — review them before re-validating'
                : 'The Apex Assistant has proposed changes'}
            </span>
            <span className={styles.bannerHint}>
              {hasContentChanges && hasBacklogChanges
                ? ' — to the PRD content and backlog'
                : hasContentChanges
                  ? ' — to the PRD content'
                  : hasBacklogChanges
                    ? ' — to the backlog'
                    : ''}
            </span>
          </div>
          {reviewStarted && (
            <span className={styles.progressChip}>
              {decisionCounts.approved + decisionCounts.rejected}/{activeUnits.length} reviewed
              {decisionCounts.pending > 0 ? ` · ${decisionCounts.pending} left` : ''}
            </span>
          )}
        </div>

        <div className={styles.bannerActions}>
          {!modalOpen && (
            <>
              <button
                type="button"
                className={styles.reviewBtn}
                onClick={() => setExpanded((v) => !v)}
                disabled={busy}
              >
                {expanded ? 'Hide Preview' : 'Preview Changes'}
              </button>
              <button
                type="button"
                className={styles.acceptBtn}
                onClick={openWizard}
                disabled={busy || builtUnits.length === 0}
              >
                {reviewStarted ? 'Continue review' : 'Review section by section'}
              </button>
              <button
                type="button"
                className={styles.rejectBtn}
                onClick={() => void handleRejectAll()}
                disabled={busy}
              >
                {isFixBaseline
                  ? (busy ? 'Reverting…' : 'Revert all')
                  : (rejectMutation.isPending ? 'Rejecting…' : 'Reject all')}
              </button>
            </>
          )}
          {modalOpen && (
            <button
              type="button"
              className={styles.reviewBtn}
              onClick={minimizeWizard}
              disabled={busy}
            >
              Minimize review
            </button>
          )}
        </div>
      </div>

      {modalPortal}

      {!modalOpen && expanded && (
        <div className={styles.diffSection}>
          {hasContentChanges && (
            <div className={styles.diffBlock}>
              <div className={styles.diffBlockLabel}>PRD Content Changes</div>
              <DiffView
                oldText={currentContent}
                newText={proposedContent!}
              />
            </div>
          )}

          {hasBacklogChanges && (
            <div className={styles.diffBlock}>
              <div className={styles.diffBlockLabel}>Backlog Changes</div>
              <BacklogChangesView
                oldJson={currentBacklogJson}
                newJson={proposedBacklogJson}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ProposedChangesReview;
