import React, { useState, useMemo } from 'react';
import { DiffView } from './DiffView';
import { useApplyProposedPrd, useRejectProposedPrd } from '../hooks/useInterviews';
import { computeBacklogDiff, countChanges } from '../utils/backlogDiff';
import type { ItemChange, FieldChange, ItemDetail, ChangeKind } from '../utils/backlogDiff';
import styles from './ProposedChangesReview.module.css';

export interface ProposedChangesReviewProps {
  prdId: string;
  currentContent: string;
  currentBacklogJson?: unknown;
  proposedContent?: string | null;
  proposedBacklogJson?: unknown;
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
}) => {
  const [expanded, setExpanded] = useState(false);

  const applyMutation = useApplyProposedPrd(prdId);
  const rejectMutation = useRejectProposedPrd(prdId);

  if (proposedContent == null && proposedBacklogJson == null) {
    return null;
  }

  const hasContentChanges = proposedContent != null;
  const hasBacklogChanges = proposedBacklogJson != null;

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
            <span className={styles.bannerTitle}>The Apex Assistant has proposed changes</span>
            <span className={styles.bannerHint}>
              {hasContentChanges && hasBacklogChanges
                ? ' — to the PRD content and backlog'
                : hasContentChanges
                  ? ' — to the PRD content'
                  : ' — to the backlog'}
            </span>
          </div>
        </div>

        <div className={styles.bannerActions}>
          <button
            type="button"
            className={styles.reviewBtn}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide Changes' : 'Review Changes'}
          </button>
          <button
            type="button"
            className={styles.acceptBtn}
            onClick={() => applyMutation.mutate()}
            disabled={applyMutation.isPending || rejectMutation.isPending}
          >
            {applyMutation.isPending ? 'Applying…' : 'Accept Changes'}
          </button>
          <button
            type="button"
            className={styles.rejectBtn}
            onClick={() => rejectMutation.mutate()}
            disabled={applyMutation.isPending || rejectMutation.isPending}
          >
            {rejectMutation.isPending ? 'Rejecting…' : 'Reject Changes'}
          </button>
        </div>
      </div>

      {expanded && (
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
