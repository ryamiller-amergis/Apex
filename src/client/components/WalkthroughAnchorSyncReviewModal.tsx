import React, { useEffect, useState } from 'react';
import {
  WALKTHROUGH_ANCHOR_SOURCE_KINDS,
  type WalkthroughAnchorRegistryRecord,
  type WalkthroughAnchorReviewStatus,
  type WalkthroughAnchorSourceKind,
} from '../../shared/types/walkthroughAnchorRegistry';
import {
  WALKTHROUGH_REGISTRY_PLACEMENTS,
  type WalkthroughRegistryPlacement,
} from '../../shared/walkthroughAnchors';
import { listWalkthroughRoutes } from '../../shared/walkthroughRoutes';
import styles from './WalkthroughAnchorManagement.module.css';

export interface WalkthroughAnchorSyncDraft
  extends Omit<WalkthroughAnchorRegistryRecord, 'allowedPlacements' | 'smartTags'> {
  allowedPlacements: WalkthroughRegistryPlacement[];
  smartTags: string[];
  /** UI-only warning toggle for review shell. */
  warnMissing: boolean;
}

export interface WalkthroughAnchorSyncReviewModalProps {
  candidates: readonly WalkthroughAnchorRegistryRecord[];
  onClose: () => void;
  /** Persist approved/rejected drafts (may be async). Modal stays open on throw. */
  onSave?: (drafts: WalkthroughAnchorSyncDraft[]) => void | Promise<void>;
  onApproveSelected?: (ids: string[]) => void;
  onRejectSelected?: (ids: string[]) => void;
  /** Optional Track B enrichment status banner. */
  enrichmentStatus?: 'idle' | 'running' | 'ready' | 'failed';
  enrichmentMessage?: string | null;
  /** Stop waiting on the AI batch and unlock Save (agent may still finish server-side). */
  onSkipWaitingForAi?: () => void;
  /**
   * Re-run Sync + next AI batch of up to 20 while keeping this modal open.
   * Shown when more candidates still need AI tags.
   */
  onRunNextAiBatch?: () => void;
  nextAiBatchPending?: boolean;
}

function toDraft(record: WalkthroughAnchorRegistryRecord): WalkthroughAnchorSyncDraft {
  return {
    ...record,
    allowedPlacements: [...record.allowedPlacements],
    smartTags: [...record.smartTags],
    warnMissing: record.missingSince != null,
  };
}

type ProvenanceBadge = 'Scanner only' | 'Awaiting AI' | 'AI enriched';

function provenanceBadge(
  draft: WalkthroughAnchorSyncDraft,
  enrichmentRunning: boolean,
): ProvenanceBadge {
  const model = draft.aiProvenance?.model?.trim();
  const hasRealAi =
    !!model &&
    model !== 'sync-heuristic' &&
    (draft.smartTags.length > 0 || !!draft.aiProvenance?.rationale?.trim());
  if (hasRealAi) return 'AI enriched';
  if (enrichmentRunning) return 'Awaiting AI';
  if (draft.smartTags.length === 0 && !draft.aiProvenance?.rationale?.trim()) {
    return 'Scanner only';
  }
  if (model === 'sync-heuristic' || !model) return 'Scanner only';
  return 'Awaiting AI';
}

/** Prefer AI-tagged rows first so the batch that just finished is visible. */
function sortDraftsForReview(drafts: WalkthroughAnchorSyncDraft[]): WalkthroughAnchorSyncDraft[] {
  const rank = (d: WalkthroughAnchorSyncDraft) => {
    const badge = provenanceBadge(d, false);
    if (badge === 'AI enriched') return 0;
    if (badge === 'Awaiting AI') return 1;
    return 2;
  };
  return [...drafts].sort((a, b) => rank(a) - rank(b));
}

function badgeClass(badge: ProvenanceBadge): string {
  if (badge === 'AI enriched') return styles.provenanceAi;
  if (badge === 'Awaiting AI') return styles.provenanceAwaiting;
  return styles.provenanceScanner;
}

const SyncReviewInfoIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
    <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
  </svg>
);

export const WalkthroughAnchorSyncReviewModal: React.FC<
  WalkthroughAnchorSyncReviewModalProps
> = ({
  candidates,
  onClose,
  onSave,
  onApproveSelected,
  onRejectSelected,
  enrichmentStatus = 'idle',
  enrichmentMessage = null,
  onSkipWaitingForAi,
  onRunNextAiBatch,
  nextAiBatchPending = false,
}) => {
  const [drafts, setDrafts] = useState<WalkthroughAnchorSyncDraft[]>(() =>
    sortDraftsForReview(candidates.map(toDraft)),
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showWorkflowInfo, setShowWorkflowInfo] = useState(false);

  useEffect(() => {
    setDrafts(sortDraftsForReview(candidates.map(toDraft)));
    setSelectedIds(new Set());
    setSaveError(null);
  }, [candidates]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, saving]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(drafts.map((d) => d.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const updateDraft = <K extends keyof WalkthroughAnchorSyncDraft>(
    id: string,
    key: K,
    value: WalkthroughAnchorSyncDraft[K],
  ) => {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, [key]: value } : d)),
    );
  };

  const setReviewStatusForIds = (ids: string[], status: WalkthroughAnchorReviewStatus) => {
    const idSet = new Set(ids);
    setDrafts((prev) =>
      prev.map((d) =>
        idSet.has(d.id)
          ? {
              ...d,
              reviewStatus: status,
              // Approve → activate for runtime allow-list; reject always deactivates.
              isActive: status === 'approved',
            }
          : d,
      ),
    );
  };

  const togglePlacement = (id: string, placement: WalkthroughRegistryPlacement) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.id !== id) return d;
        const has = d.allowedPlacements.includes(placement);
        const allowedPlacements = has
          ? d.allowedPlacements.filter((p) => p !== placement)
          : [...d.allowedPlacements, placement];
        return { ...d, allowedPlacements };
      }),
    );
  };

  const handleApproveAll = () => {
    const ids = drafts.map((d) => d.id);
    setReviewStatusForIds(ids, 'approved');
    onApproveSelected?.(ids);
  };

  const handleRejectAll = () => {
    const ids = drafts.map((d) => d.id);
    setReviewStatusForIds(ids, 'rejected');
    onRejectSelected?.(ids);
  };

  const handleApproveSelected = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setReviewStatusForIds(ids, 'approved');
    onApproveSelected?.(ids);
  };

  const handleRejectSelected = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setReviewStatusForIds(ids, 'rejected');
    onRejectSelected?.(ids);
  };

  const enrichmentRunning = enrichmentStatus === 'running';
  const saveDisabled = saving || enrichmentRunning;

  const handleSave = async () => {
    if (enrichmentRunning) return;
    if (!onSave) {
      onClose();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(drafts);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save sync review');
    } finally {
      setSaving(false);
    }
  };

  const routes = listWalkthroughRoutes();
  const aiEnrichedCount = drafts.filter(
    (d) => provenanceBadge(d, false) === 'AI enriched',
  ).length;
  const scannerOnlyCount = drafts.length - aiEnrichedCount;
  const showNextBatch =
    !!onRunNextAiBatch &&
    scannerOnlyCount > 0 &&
    enrichmentStatus !== 'running';

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- overlay dismiss; dialog actions handle keyboard
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="anchor-sync-review-title"
      {...{ 'data-testid': 'walkthrough-anchor-sync-modal' }}
    >
      <div className={styles.modalCard}>
        <div className={styles.modalHeader}>
          <div>
            <div className={styles.modalTitleRow}>
              <h2 className={styles.modalTitle} id="anchor-sync-review-title">
                Sync review
              </h2>
              <div
                className={styles.infoIcon}
                onClick={() => setShowWorkflowInfo((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setShowWorkflowInfo((v) => !v);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="Show information about sync status and AI batching"
                aria-expanded={showWorkflowInfo}
                {...{ 'data-testid': 'walkthrough-anchor-sync-info' }}
              >
                <SyncReviewInfoIcon />
              </div>
            </div>
            <p className={styles.modalHint}>
              Scanner finds coachable surfaces; AI fills tags/route/rationale in batches of 20.
              Approve, reject, or edit before saving.
            </p>
          </div>
          <button
            type="button"
            className={styles.button}
            onClick={onClose}
            {...{ 'data-testid': 'walkthrough-anchor-sync-close' }}
          >
            Close
          </button>
        </div>

        {showWorkflowInfo && (
          <div
            className={styles.infoTooltip}
            {...{ 'data-testid': 'walkthrough-anchor-sync-info-panel' }}
          >
            <button
              type="button"
              className={styles.infoClose}
              onClick={() => setShowWorkflowInfo(false)}
              aria-label="Close information"
              {...{ 'data-testid': 'walkthrough-anchor-sync-info-close' }}
            >
              ×
            </button>
            <p>
              <strong>What Sync does:</strong>
              <br />
              Scans the Apex client for coachable UI surfaces (menus, sections, forms, grids, etc.)
              and creates <em>pending</em> catalog rows. It does <em>not</em> invent tags or routes —
              those stay empty until AI (or you) fills them.
            </p>
            <p>
              <strong>What AI smart-tagging does:</strong>
              <br />
              A Cursor agent reviews up to <em>20</em> pending candidates per batch and suggests{' '}
              <em>tags</em>, <em>suggested route</em>, <em>placements</em>, and a short{' '}
              <em>rationale</em>. Large syncs need multiple batches — use{' '}
              <em>Tag next AI batch</em> until scanner-only rows are gone (or you approve/reject them).
            </p>
            <p>
              <strong>Status badges:</strong>
              <br />
              <em>Scanner only</em> — discovered by Sync; tags/route/rationale still empty.
              <br />
              <em>Awaiting AI</em> — a smart-tagging batch is running for this list.
              <br />
              <em>AI enriched</em> — this batch (or a prior one) wrote real AI metadata on the row.
            </p>
            <p>
              <strong>How to finish:</strong>
              <br />
              Review AI fields → Approve / Reject → <em>Save</em>. Closing without Save keeps rows
              pending so the next Sync / Tag next AI batch can continue.
            </p>
          </div>
        )}

        {enrichmentStatus === 'running' && (
          <div {...{ 'data-testid': 'walkthrough-anchor-sync-enrichment-running' }}>
            <p className={styles.warningText}>
              {enrichmentMessage ??
                'AI smart-tagging is running on this batch (tags, route, placements, rationale). Save is disabled until it finishes.'}
            </p>
            {onSkipWaitingForAi && (
              <button
                type="button"
                className={styles.buttonGhost}
                onClick={onSkipWaitingForAi}
                {...{ 'data-testid': 'walkthrough-anchor-sync-skip-waiting' }}
              >
                Skip waiting — edit &amp; Save now
              </button>
            )}
          </div>
        )}
        {enrichmentStatus === 'ready' && (
          <div {...{ 'data-testid': 'walkthrough-anchor-sync-enrichment-ready' }}>
            <p className={styles.hint}>
              {enrichmentMessage ??
                'AI smart-tagging finished for this batch. Review updated fields, then approve/reject and Save.'}
            </p>
            {showNextBatch && (
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={nextAiBatchPending}
                onClick={onRunNextAiBatch}
                {...{ 'data-testid': 'walkthrough-anchor-sync-next-batch' }}
              >
                {nextAiBatchPending ? 'Starting next AI batch…' : 'Tag next AI batch'}
              </button>
            )}
          </div>
        )}
        {enrichmentStatus === 'failed' && (
          <div {...{ 'data-testid': 'walkthrough-anchor-sync-enrichment-failed' }}>
            <p className={styles.warningText}>
              {enrichmentMessage ??
                'AI smart-tagging did not finish. Tags/route stay empty until you Sync again or edit manually — you can still Save.'}
            </p>
            {showNextBatch && (
              <button
                type="button"
                className={styles.button}
                disabled={nextAiBatchPending}
                onClick={onRunNextAiBatch}
                {...{ 'data-testid': 'walkthrough-anchor-sync-next-batch' }}
              >
                {nextAiBatchPending ? 'Starting next AI batch…' : 'Retry / tag next AI batch'}
              </button>
            )}
          </div>
        )}
        {enrichmentStatus === 'idle' && drafts.length > 0 && (
          <div {...{ 'data-testid': 'walkthrough-anchor-sync-enrichment-idle' }}>
            <p className={styles.hint}>
              {scannerOnlyCount} scanner-only · {aiEnrichedCount} AI-enriched. Empty tags/route mean
              AI has not run on those rows yet.
            </p>
            {showNextBatch && (
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={nextAiBatchPending}
                onClick={onRunNextAiBatch}
                {...{ 'data-testid': 'walkthrough-anchor-sync-next-batch' }}
              >
                {nextAiBatchPending ? 'Starting next AI batch…' : 'Tag next AI batch'}
              </button>
            )}
          </div>
        )}

        <div className={styles.syncToolbar}>
          <button
            type="button"
            className={styles.buttonGhost}
            onClick={selectAll}
            {...{ 'data-testid': 'walkthrough-anchor-sync-select-all' }}
          >
            Select all
          </button>
          <button
            type="button"
            className={styles.buttonGhost}
            onClick={clearSelection}
            {...{ 'data-testid': 'walkthrough-anchor-sync-clear-selection' }}
          >
            Clear selection
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={handleApproveAll}
            {...{ 'data-testid': 'walkthrough-anchor-sync-approve-all' }}
          >
            Approve All
          </button>
          <button
            type="button"
            className={styles.buttonDanger}
            onClick={handleRejectAll}
            {...{ 'data-testid': 'walkthrough-anchor-sync-reject-all' }}
          >
            Reject All
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={selectedIds.size === 0}
            onClick={handleApproveSelected}
            {...{ 'data-testid': 'walkthrough-anchor-sync-approve-selected' }}
          >
            Approve selected
          </button>
          <button
            type="button"
            className={styles.buttonDanger}
            disabled={selectedIds.size === 0}
            onClick={handleRejectSelected}
            {...{ 'data-testid': 'walkthrough-anchor-sync-reject-selected' }}
          >
            Reject selected
          </button>
        </div>

        <div className={styles.modalBody}>
          {drafts.length === 0 ? (
            <p className={styles.empty} {...{ 'data-testid': 'walkthrough-anchor-sync-empty' }}>
              No pending candidates to review.
            </p>
          ) : (
            <div className={styles.syncList}>
              {drafts.map((draft) => {
                const selected = selectedIds.has(draft.id);
                const rationale = draft.aiProvenance?.rationale ?? '';
                const badge = provenanceBadge(draft, enrichmentRunning);
                return (
                  <div
                    key={draft.id}
                    className={selected ? styles.syncRowSelected : styles.syncRow}
                    {...{ 'data-testid': `walkthrough-anchor-sync-row-${draft.id}` }}
                  >
                    <input
                      type="checkbox"
                      className={styles.syncCheckbox}
                      checked={selected}
                      onChange={() => toggleSelected(draft.id)}
                      aria-label={`Select ${draft.anchorKey}`}
                      {...{ 'data-testid': `walkthrough-anchor-sync-select-${draft.id}` }}
                    />
                    <div className={styles.syncFields}>
                      <div className={styles.syncRowMeta}>
                        <span
                          className={`${styles.provenanceBadge} ${badgeClass(badge)}`}
                          {...{ 'data-testid': `walkthrough-anchor-sync-provenance-${draft.id}` }}
                        >
                          {badge}
                        </span>
                        <span className={styles.hint}>
                          Review status: <strong>{draft.reviewStatus}</strong>
                        </span>
                      </div>
                      <label className={styles.field}>
                        <span className={styles.label}>Anchor key</span>
                        <input
                          className={styles.input}
                          value={draft.anchorKey}
                          onChange={(e) => updateDraft(draft.id, 'anchorKey', e.target.value)}
                          {...{ 'data-testid': `walkthrough-anchor-sync-key-${draft.id}` }}
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>Test ID</span>
                        <input
                          className={styles.input}
                          value={draft.testId}
                          onChange={(e) => updateDraft(draft.id, 'testId', e.target.value)}
                          {...{ 'data-testid': `walkthrough-anchor-sync-testid-${draft.id}` }}
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>Label</span>
                        <input
                          className={styles.input}
                          value={draft.label}
                          onChange={(e) => updateDraft(draft.id, 'label', e.target.value)}
                          {...{ 'data-testid': `walkthrough-anchor-sync-label-${draft.id}` }}
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>Suggested route</span>
                        <select
                          className={styles.select}
                          value={draft.suggestedRoute ?? ''}
                          onChange={(e) =>
                            updateDraft(draft.id, 'suggestedRoute', e.target.value || null)
                          }
                          {...{ 'data-testid': `walkthrough-anchor-sync-route-${draft.id}` }}
                        >
                          <option value="">None</option>
                          {routes.map((r) => (
                            <option key={r.route} value={r.route}>
                              {r.label} ({r.route})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>Source</span>
                        <select
                          className={styles.select}
                          value={draft.sourceKind}
                          onChange={(e) =>
                            updateDraft(
                              draft.id,
                              'sourceKind',
                              e.target.value as WalkthroughAnchorSourceKind,
                            )
                          }
                          {...{ 'data-testid': `walkthrough-anchor-sync-source-${draft.id}` }}
                        >
                          {WALKTHROUGH_ANCHOR_SOURCE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {kind}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>Tags (comma-separated)</span>
                        <input
                          className={styles.input}
                          value={draft.smartTags.join(', ')}
                          placeholder="Filled by AI"
                          onChange={(e) =>
                            updateDraft(
                              draft.id,
                              'smartTags',
                              e.target.value
                                .split(',')
                                .map((t) => t.trim())
                                .filter(Boolean),
                            )
                          }
                          {...{ 'data-testid': `walkthrough-anchor-sync-tags-${draft.id}` }}
                        />
                      </label>
                      <div className={`${styles.field} ${styles.fieldWide}`}>
                        <span className={styles.label}>Placements</span>
                        <div className={styles.placementChecks}>
                          {WALKTHROUGH_REGISTRY_PLACEMENTS.map((placement) => (
                            <label key={placement} className={styles.checkboxLabel}>
                              <input
                                type="checkbox"
                                checked={draft.allowedPlacements.includes(placement)}
                                onChange={() => togglePlacement(draft.id, placement)}
                                {...{
                                  'data-testid': `walkthrough-anchor-sync-placement-${draft.id}-${placement}`,
                                }}
                              />
                              {placement}
                            </label>
                          ))}
                        </div>
                      </div>
                      <label className={`${styles.field} ${styles.fieldWide}`}>
                        <span className={styles.label}>Source evidence</span>
                        <textarea
                          className={styles.textarea}
                          value={draft.sourceLocations.map((l) => l.filePath).join('\n')}
                          onChange={(e) =>
                            updateDraft(
                              draft.id,
                              'sourceLocations',
                              e.target.value
                                .split('\n')
                                .map((line) => line.trim())
                                .filter(Boolean)
                                .map((filePath) => ({
                                  filePath,
                                  discoveryKind: draft.sourceKind,
                                })),
                            )
                          }
                          {...{ 'data-testid': `walkthrough-anchor-sync-evidence-${draft.id}` }}
                        />
                      </label>
                      <label className={`${styles.field} ${styles.fieldWide}`}>
                        <span className={styles.label}>AI rationale</span>
                        <textarea
                          className={styles.textarea}
                          value={rationale}
                          placeholder="Filled by AI"
                          onChange={(e) =>
                            updateDraft(draft.id, 'aiProvenance', {
                              provider: draft.aiProvenance?.provider ?? 'cursor',
                              model: draft.aiProvenance?.model ?? 'unknown',
                              skillPath:
                                draft.aiProvenance?.skillPath ??
                                '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
                              generatedAt:
                                draft.aiProvenance?.generatedAt ?? new Date().toISOString(),
                              confidence: draft.aiProvenance?.confidence ?? null,
                              rationale: e.target.value,
                              runId: draft.aiProvenance?.runId ?? null,
                              threadId: draft.aiProvenance?.threadId ?? null,
                            })
                          }
                          {...{ 'data-testid': `walkthrough-anchor-sync-rationale-${draft.id}` }}
                        />
                      </label>
                      <label className={styles.checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={draft.warnMissing}
                          onChange={(e) =>
                            updateDraft(draft.id, 'warnMissing', e.target.checked)
                          }
                          {...{ 'data-testid': `walkthrough-anchor-sync-warn-${draft.id}` }}
                        />
                        Missing / warning state
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {saveError && (
          <p className={styles.warningText} {...{ 'data-testid': 'walkthrough-anchor-sync-save-error' }}>
            {saveError}
          </p>
        )}

        <div className={styles.modalFooter}>
          <button
            type="button"
            className={styles.button}
            onClick={onClose}
            disabled={saving}
            {...{ 'data-testid': 'walkthrough-anchor-sync-cancel' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            onClick={() => void handleSave()}
            disabled={saveDisabled}
            title={
              enrichmentRunning
                ? 'Wait for AI smart-tagging to finish before saving'
                : undefined
            }
            {...{ 'data-testid': 'walkthrough-anchor-sync-save' }}
          >
            {saving ? 'Saving…' : enrichmentRunning ? 'Waiting for AI…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
