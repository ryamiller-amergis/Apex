import React, { useState, useEffect, useCallback } from 'react';
import DiffView from './DiffView';
import { useApplyProposal, useRejectProposal, useUpdateProposalField } from '../hooks/useCalendarWorkItemAssistant';
import type {
  WorkItemChangeProposal,
  WorkItemHierarchyNode,
  WorkItemApplyItemResult,
  ProposedWorkItemChange,
} from '../../shared/types/calendarWorkItemAssistant';
import { TERMINAL_WORK_ITEM_STATES } from '../../shared/types/calendarWorkItemAssistant';
import styles from './CalendarWorkItemChangesReview.module.css';

interface Props {
  sessionId: string;
  proposal: WorkItemChangeProposal;
  snapshot: WorkItemHierarchyNode[];
  onClose: () => void;
  onApplied: () => void;
}

type ApplyStep = 'review' | 'confirm' | 'applying' | 'done';

export const CalendarWorkItemChangesReview: React.FC<Props> = ({
  sessionId,
  proposal,
  snapshot,
  onClose,
  onApplied,
}) => {
  const [approved, setApproved] = useState<Set<number>>(
    () => new Set(proposal.changeSet.changes.map(c => c.workItemId)),
  );
  const [step, setStep] = useState<ApplyStep>('review');
  const [result, setResult] = useState<import('../../shared/types/calendarWorkItemAssistant').ApplyWorkItemChangesResponse | null>(null);
  const [expandedItems, setExpandedItems] = useState<Set<number>>(() =>
    new Set(proposal.changeSet.changes.map(c => c.workItemId)),
  );
  // Local overrides for edited field values so the diff updates immediately after save
  const [localFieldEdits, setLocalFieldEdits] = useState<Record<string, string>>({}); // key: `${workItemId}:${field}`

  const applyMutation = useApplyProposal();
  const rejectMutation = useRejectProposal();

  const snapshotMap = new Map(snapshot.map(n => [n.id, n]));
  const changes = proposal.changeSet.changes;

  const hasTerminalItems = changes.some(c => {
    const node = snapshotMap.get(c.workItemId);
    return node && (TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(node.state);
  });
  const hasClearedContent = changes
    .filter(c => approved.has(c.workItemId))
    .some(c => c.fields.some(f => !f.after.trim()));

  const toggleApprove = useCallback((id: number) => {
    setApproved(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleExpand = useCallback((id: number) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    setStep('confirm');
  }, []);

  const handleConfirmApply = useCallback(async () => {
    setStep('applying');
    try {
      const res = await applyMutation.mutateAsync({
        proposalId: proposal.id,
        sessionId,
        approvedWorkItemIds: Array.from(approved),
        acknowledgeTerminalStates: hasTerminalItems,
        acknowledgeContentCleared: hasClearedContent,
      });
      setResult(res);
      setStep('done');
    } catch {
      setStep('review');
    }
  }, [applyMutation, proposal.id, sessionId, approved, hasTerminalItems, hasClearedContent]);

  const handleReject = useCallback(async () => {
    await rejectMutation.mutateAsync({ proposalId: proposal.id, sessionId });
    onClose();
  }, [rejectMutation, proposal.id, sessionId, onClose]);

  const handleClose = useCallback(() => {
    if (step === 'done') {
      onApplied();
    } else {
      onClose();
    }
  }, [step, onApplied, onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  const approvedCount = approved.size;
  const totalCount = changes.length;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-title"
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 id="review-title" className={styles.title}>
            Review Proposed Changes
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={handleClose}
            aria-label="Close review"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        {step === 'done' && result ? (
          <ResultPane result={result} onClose={handleClose} />
        ) : step === 'applying' ? (
          <div className={styles.applyingPane}>
            <div className={styles.spinner} aria-label="Applying…" />
            <p>Applying changes to Azure DevOps…</p>
          </div>
        ) : step === 'confirm' ? (
          <ConfirmPane
            approvedCount={approvedCount}
            hasTerminalItems={hasTerminalItems}
            hasClearedContent={hasClearedContent}
            error={applyMutation.error?.message}
            onConfirm={() => void handleConfirmApply()}
            onCancel={() => setStep('review')}
          />
        ) : (
          <>
            <div className={styles.body}>
              <p className={styles.summary}>
                {totalCount} work item{totalCount !== 1 ? 's' : ''} with proposed changes.
                {' '}{approvedCount} of {totalCount} selected for apply.
              </p>

              {hasTerminalItems && (
                <div className={styles.warningBanner} role="alert">
                  Some items are in a terminal state (Closed/Done/Removed). Review carefully before applying.
                </div>
              )}

              <div className={styles.itemList}>
                {changes.map(change => {
                  // Merge any locally-saved edits into the change fields
                  const mergedChange = {
                    ...change,
                    fields: change.fields.map(f => {
                      const key = `${change.workItemId}:${f.field}`;
                      return key in localFieldEdits ? { ...f, after: localFieldEdits[key] } : f;
                    }),
                  };
                  return (
                    <ChangeItemAccordion
                      key={change.workItemId}
                      change={mergedChange}
                      node={snapshotMap.get(change.workItemId)}
                      approved={approved.has(change.workItemId)}
                      expanded={expandedItems.has(change.workItemId)}
                      proposalId={proposal.id}
                      sessionId={sessionId}
                      onToggleApprove={() => toggleApprove(change.workItemId)}
                      onToggleExpand={() => toggleExpand(change.workItemId)}
                      onFieldSaved={(field, newAfter) =>
                        setLocalFieldEdits(prev => ({
                          ...prev,
                          [`${change.workItemId}:${field}`]: newAfter,
                        }))
                      }
                    />
                  );
                })}
              </div>
            </div>

            <div className={styles.footer}>
              {applyMutation.error && (
                <p className={styles.applyError} role="alert">
                  {applyMutation.error.message}
                </p>
              )}
              <div className={styles.footerActions}>
                <button
                  type="button"
                  className={styles.btnReject}
                  onClick={() => void handleReject()}
                  disabled={rejectMutation.isPending}
                >
                  Discard all
                </button>
                <button
                  type="button"
                  className={styles.btnApply}
                  onClick={handleApply}
                  disabled={approvedCount === 0}
                >
                  Apply {approvedCount} item{approvedCount !== 1 ? 's' : ''} →
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────────────

interface ChangeItemAccordionProps {
  change: ProposedWorkItemChange;
  node: WorkItemHierarchyNode | undefined;
  approved: boolean;
  expanded: boolean;
  proposalId: string;
  sessionId: string;
  onToggleApprove: () => void;
  onToggleExpand: () => void;
  onFieldSaved: (field: string, newAfter: string) => void;
}

const FIELD_LABELS: Record<string, string> = {
  description: 'Description',
  acceptanceCriteria: 'Acceptance Criteria',
};

const ChangeItemAccordion: React.FC<ChangeItemAccordionProps> = ({
  change, node, approved, expanded, proposalId, sessionId,
  onToggleApprove, onToggleExpand, onFieldSaved,
}) => {
  const isTerminal = node && (TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(node.state);
  const itemId = `item-${change.workItemId}`;

  const updateField = useUpdateProposalField();
  const [editingField, setEditingField] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const handleEdit = (field: string, currentAfter: string) => {
    setEditingField(field);
    setEditValue(currentAfter);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!editingField) return;
    setSaveError(null);
    try {
      await updateField.mutateAsync({
        proposalId,
        sessionId,
        workItemId: change.workItemId,
        field: editingField as 'description' | 'acceptanceCriteria',
        after: editValue,
      });
      onFieldSaved(editingField, editValue);
      setEditingField(null);
    } catch (err: any) {
      setSaveError(err.message ?? 'Save failed');
    }
  };

  return (
    <div className={`${styles.changeItem} ${approved ? styles.changeItemApproved : ''}`}>
      <div className={styles.changeItemHeader}>
        <label className={styles.changeItemLabel}>
          <input
            type="checkbox"
            checked={approved}
            onChange={onToggleApprove}
            aria-label={`Approve changes for #${change.workItemId}`}
          />
          <span className={styles.changeItemType}>{change.workItemType}</span>
          <span className={styles.changeItemId}>#{change.workItemId}</span>
          <span className={styles.changeItemTitle}>{change.title}</span>
          {isTerminal && <span className={styles.terminalBadge}>{node!.state}</span>}
          <span className={styles.fieldCount}>
            {change.fields.length} field{change.fields.length !== 1 ? 's' : ''}
          </span>
        </label>
        <button
          type="button"
          className={styles.expandBtn}
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-controls={itemId}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"
            style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s' }}
          >
            <path d="M2 4l4 4 4-4" />
          </svg>
        </button>
      </div>

      {expanded && (
        <div id={itemId} className={styles.changeItemBody}>
          {saveError && <p className={styles.applyError}>{saveError}</p>}
          {change.fields.map(f => (
            <div key={f.field} className={styles.fieldDiff}>
              <div className={styles.fieldDiffHeader}>
                <span className={styles.fieldDiffLabel}>{FIELD_LABELS[f.field] ?? f.field}</span>
                {editingField !== f.field && (
                  <button
                    type="button"
                    className={styles.editBtn}
                    onClick={() => handleEdit(f.field, f.after)}
                    title="Edit proposed content"
                  >
                    ✏ Edit
                  </button>
                )}
              </div>

              {editingField === f.field ? (
                <div className={styles.editArea}>
                  <textarea
                    className={styles.editTextarea}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    rows={10}
                    autoFocus
                    aria-label={`Edit ${FIELD_LABELS[f.field]}`}
                  />
                  <div className={styles.editActions}>
                    <button
                      type="button"
                      className={styles.btnReject}
                      onClick={() => setEditingField(null)}
                      disabled={updateField.isPending}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.btnApply}
                      onClick={() => void handleSave()}
                      disabled={updateField.isPending}
                    >
                      {updateField.isPending ? 'Saving…' : '✓ Save changes'}
                    </button>
                  </div>
                </div>
              ) : (
                <DiffView oldText={f.before} newText={f.after} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface ConfirmPaneProps {
  approvedCount: number;
  hasTerminalItems: boolean;
  hasClearedContent: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmPane: React.FC<ConfirmPaneProps> = ({
  approvedCount, hasTerminalItems, hasClearedContent, error, onConfirm, onCancel,
}) => (
  <div className={styles.confirmPane}>
    <p className={styles.confirmSummary}>
      You are about to write changes to {approvedCount} work item{approvedCount !== 1 ? 's' : ''} in Azure DevOps.
      {' '}This action cannot be undone through Apex.
    </p>

    {hasTerminalItems && (
      <div className={styles.confirmWarning}>
        One or more items are in a terminal state (Closed/Done/Removed). Changes will still be applied.
      </div>
    )}
    {hasClearedContent && (
      <div className={styles.confirmWarning}>
        One or more fields will be set to empty. Confirm this is intended.
      </div>
    )}

    {error && <p className={styles.applyError} role="alert">{error}</p>}

    <div className={styles.confirmActions}>
      <button type="button" className={styles.btnReject} onClick={onCancel}>
        Back
      </button>
      <button type="button" className={styles.btnApply} onClick={onConfirm}>
        Confirm — apply {approvedCount} item{approvedCount !== 1 ? 's' : ''}
      </button>
    </div>
  </div>
);

interface ResultPaneProps {
  result: import('../../shared/types/calendarWorkItemAssistant').ApplyWorkItemChangesResponse;
  onClose: () => void;
}

const ResultPane: React.FC<ResultPaneProps> = ({ result, onClose }) => (
  <div className={styles.resultPane}>
    <div className={styles.resultSummary}>
      <ResultRow items={result.applied} label="Applied" variant="success" />
      <ResultRow items={result.stale} label="Stale — re-propose needed" variant="warning" />
      <ResultRow items={result.failed} label="Failed" variant="error" />
      <ResultRow items={result.skipped} label="Not selected" variant="neutral" />
    </div>
    <div className={styles.resultActions}>
      <button type="button" className={styles.btnApply} onClick={onClose}>
        Done
      </button>
    </div>
  </div>
);

const ResultRow: React.FC<{
  items: WorkItemApplyItemResult[];
  label: string;
  variant: 'success' | 'warning' | 'error' | 'neutral';
}> = ({ items, label, variant }) => {
  if (items.length === 0) return null;
  return (
    <div className={`${styles.resultRow} ${styles[`resultRow${variant.charAt(0).toUpperCase() + variant.slice(1)}`]}`}>
      <span className={styles.resultLabel}>{label} ({items.length})</span>
      <ul className={styles.resultItemList}>
        {items.map(r => (
          <li key={r.workItemId}>
            #{r.workItemId}
            {r.reason && <> — {r.reason}</>}
            {r.error && <> — {r.error}</>}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default CalendarWorkItemChangesReview;
