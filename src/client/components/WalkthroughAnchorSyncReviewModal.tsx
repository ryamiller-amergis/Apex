import React, { useEffect, useMemo, useState } from 'react';
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
import {
  SMART_TAGGING_BATCH_SIZE_DEFAULT,
  SMART_TAGGING_BATCH_SIZE_OPTIONS,
  hasRealAiProvenance,
  type SmartTaggingBatchSize,
} from '../hooks/usePlatformAdminAnchorRegistry';
import styles from './WalkthroughAnchorManagement.module.css';

/** Catalog rows always allow all coachmark sides; preferred side is per walkthrough step. */
const ALL_PLACEMENTS: WalkthroughRegistryPlacement[] = [...WALKTHROUGH_REGISTRY_PLACEMENTS];

export interface WalkthroughAnchorSyncDraft
  extends Omit<WalkthroughAnchorRegistryRecord, 'allowedPlacements' | 'smartTags'> {
  allowedPlacements: WalkthroughRegistryPlacement[];
  smartTags: string[];
  /** UI-only warning toggle for review shell. */
  warnMissing: boolean;
}

export type SyncReviewSectionId =
  | 'ready'
  | 'needs_ai'
  | 'approved'
  | 'rejected';

export interface WalkthroughAnchorSyncReviewModalProps {
  candidates: readonly WalkthroughAnchorRegistryRecord[];
  onClose: () => void;
  /**
   * Persist decided (approved/rejected) drafts. Modal stays open on success so
   * remaining rows can continue through the next AI batch.
   */
  onSave?: (drafts: WalkthroughAnchorSyncDraft[]) => void | Promise<void>;
  onApproveSelected?: (ids: string[]) => void;
  onRejectSelected?: (ids: string[]) => void;
  enrichmentStatus?: 'idle' | 'running' | 'ready' | 'failed';
  enrichmentMessage?: string | null;
  onSkipWaitingForAi?: () => void;
  /**
   * Re-run Sync + next AI batch while keeping this modal open.
   * Batch size comes from the chooser in this modal.
   */
  onRunNextAiBatch?: (batchSize: SmartTaggingBatchSize) => void;
  nextAiBatchPending?: boolean;
  batchSize?: SmartTaggingBatchSize;
  onBatchSizeChange?: (size: SmartTaggingBatchSize) => void;
}

function toDraft(record: WalkthroughAnchorRegistryRecord): WalkthroughAnchorSyncDraft {
  return {
    ...record,
    allowedPlacements: [...ALL_PLACEMENTS],
    smartTags: [...record.smartTags],
    warnMissing: record.missingSince != null,
  };
}

type ProvenanceBadge = 'Scanner only' | 'Awaiting AI' | 'AI enriched';

function provenanceBadge(
  draft: WalkthroughAnchorSyncDraft,
  enrichmentRunning: boolean,
): ProvenanceBadge {
  if (hasRealAiProvenance(draft)) return 'AI enriched';
  if (enrichmentRunning) return 'Awaiting AI';
  if (draft.smartTags.length === 0 && !draft.aiProvenance?.rationale?.trim()) {
    return 'Scanner only';
  }
  const model = draft.aiProvenance?.model?.trim();
  if (model === 'sync-heuristic' || !model) return 'Scanner only';
  return 'Awaiting AI';
}

function sectionForDraft(
  draft: WalkthroughAnchorSyncDraft,
  enrichmentRunning: boolean,
): SyncReviewSectionId {
  if (draft.reviewStatus === 'approved') return 'approved';
  if (draft.reviewStatus === 'rejected') return 'rejected';
  if (provenanceBadge(draft, enrichmentRunning) === 'AI enriched') return 'ready';
  return 'needs_ai';
}

const SECTION_ORDER: SyncReviewSectionId[] = ['ready', 'needs_ai', 'approved', 'rejected'];

const SECTION_LABELS: Record<SyncReviewSectionId, string> = {
  ready: 'Ready for review (AI enriched)',
  needs_ai: 'Still need AI / scanner only',
  approved: 'Approved (not saved yet)',
  rejected: 'Rejected (not saved yet)',
};

/**
 * Merge incoming catalog candidates into open drafts without wiping local
 * approve/reject decisions or already-AI-enriched fields.
 */
export function mergeSyncReviewDraftsFromCandidates(
  prev: readonly WalkthroughAnchorSyncDraft[],
  candidates: readonly WalkthroughAnchorRegistryRecord[],
): WalkthroughAnchorSyncDraft[] {
  const prevById = new Map(prev.map((d) => [d.id, d]));
  const next: WalkthroughAnchorSyncDraft[] = [];

  for (const candidate of candidates) {
    const existing = prevById.get(candidate.id);
    if (!existing) {
      next.push(toDraft(candidate));
      continue;
    }
    // Keep local review decision + activation.
    const reviewStatus = existing.reviewStatus;
    const isActive = existing.isActive;
    const warnMissing = existing.warnMissing;
    if (hasRealAiProvenance(existing) || reviewStatus !== 'pending') {
      next.push({
        ...existing,
        // Refresh non-AI presence metadata from server when still pending.
        lastSeenAt: candidate.lastSeenAt ?? existing.lastSeenAt,
        missingSince: candidate.missingSince ?? existing.missingSince,
        reviewStatus,
        isActive,
        warnMissing,
      });
      continue;
    }
    // Pending without real AI: take server/AI field updates, keep local edits for
    // fields the user may have typed only when server has nothing new — prefer server.
    next.push({
      ...toDraft(candidate),
      reviewStatus,
      isActive,
      warnMissing,
      // Preserve in-progress local edits when server row still lacks AI.
      label: existing.label !== candidate.label ? existing.label : candidate.label,
      smartTags:
        existing.smartTags.length > 0 && candidate.smartTags.length === 0
          ? existing.smartTags
          : [...candidate.smartTags],
      suggestedRoute:
        existing.suggestedRoute && !candidate.suggestedRoute
          ? existing.suggestedRoute
          : candidate.suggestedRoute,
      allowedPlacements: [...ALL_PLACEMENTS],
    });
  }

  return next;
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

interface SyncDraftRowProps {
  draft: WalkthroughAnchorSyncDraft;
  selected: boolean;
  enrichmentRunning: boolean;
  routes: ReturnType<typeof listWalkthroughRoutes>;
  onToggleSelected: (id: string) => void;
  onUpdate: <K extends keyof WalkthroughAnchorSyncDraft>(
    id: string,
    key: K,
    value: WalkthroughAnchorSyncDraft[K],
  ) => void;
}

const SyncDraftRow: React.FC<SyncDraftRowProps> = ({
  draft,
  selected,
  enrichmentRunning,
  routes,
  onToggleSelected,
  onUpdate,
}) => {
  const rationale = draft.aiProvenance?.rationale ?? '';
  const badge = provenanceBadge(draft, enrichmentRunning);
  return (
    <div
      className={selected ? styles.syncRowSelected : styles.syncRow}
      {...{ 'data-testid': `walkthrough-anchor-sync-row-${draft.id}` }}
    >
      <input
        type="checkbox"
        className={styles.syncCheckbox}
        checked={selected}
        onChange={() => onToggleSelected(draft.id)}
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
            onChange={(e) => onUpdate(draft.id, 'anchorKey', e.target.value)}
            {...{ 'data-testid': `walkthrough-anchor-sync-key-${draft.id}` }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Test ID</span>
          <input
            className={styles.input}
            value={draft.testId}
            onChange={(e) => onUpdate(draft.id, 'testId', e.target.value)}
            {...{ 'data-testid': `walkthrough-anchor-sync-testid-${draft.id}` }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Label</span>
          <input
            className={styles.input}
            value={draft.label}
            onChange={(e) => onUpdate(draft.id, 'label', e.target.value)}
            {...{ 'data-testid': `walkthrough-anchor-sync-label-${draft.id}` }}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Suggested route</span>
          <select
            className={styles.select}
            value={draft.suggestedRoute ?? ''}
            onChange={(e) => onUpdate(draft.id, 'suggestedRoute', e.target.value || null)}
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
              onUpdate(draft.id, 'sourceKind', e.target.value as WalkthroughAnchorSourceKind)
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
              onUpdate(
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
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span className={styles.label}>Source evidence</span>
          <textarea
            className={styles.textarea}
            value={draft.sourceLocations.map((l) => l.filePath).join('\n')}
            onChange={(e) =>
              onUpdate(
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
              onUpdate(draft.id, 'aiProvenance', {
                provider: draft.aiProvenance?.provider ?? 'cursor',
                model: draft.aiProvenance?.model ?? 'unknown',
                skillPath:
                  draft.aiProvenance?.skillPath ??
                  '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
                generatedAt: draft.aiProvenance?.generatedAt ?? new Date().toISOString(),
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
            onChange={(e) => onUpdate(draft.id, 'warnMissing', e.target.checked)}
            {...{ 'data-testid': `walkthrough-anchor-sync-warn-${draft.id}` }}
          />
          Missing / warning state
        </label>
      </div>
    </div>
  );
};

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
  batchSize: batchSizeProp,
  onBatchSizeChange,
}) => {
  const [drafts, setDrafts] = useState<WalkthroughAnchorSyncDraft[]>(() =>
    candidates.map(toDraft),
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showWorkflowInfo, setShowWorkflowInfo] = useState(false);
  const [localBatchSize, setLocalBatchSize] = useState<SmartTaggingBatchSize>(
    batchSizeProp ?? SMART_TAGGING_BATCH_SIZE_DEFAULT,
  );

  const batchSize = batchSizeProp ?? localBatchSize;
  const setBatchSize = (size: SmartTaggingBatchSize) => {
    setLocalBatchSize(size);
    onBatchSizeChange?.(size);
  };

  useEffect(() => {
    if (batchSizeProp != null) setLocalBatchSize(batchSizeProp);
  }, [batchSizeProp]);

  useEffect(() => {
    setDrafts((prev) => mergeSyncReviewDraftsFromCandidates(prev, candidates));
    setSelectedIds((prev) => {
      const next = new Set<string>();
      const ids = new Set(candidates.map((c) => c.id));
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
      }
      return next;
    });
    setSaveError(null);
  }, [candidates]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, saving]);

  const enrichmentRunning = enrichmentStatus === 'running';

  const sections = useMemo(() => {
    const map: Record<SyncReviewSectionId, WalkthroughAnchorSyncDraft[]> = {
      ready: [],
      needs_ai: [],
      approved: [],
      rejected: [],
    };
    for (const draft of drafts) {
      map[sectionForDraft(draft, enrichmentRunning)].push(draft);
    }
    return map;
  }, [drafts, enrichmentRunning]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectSection = (sectionId: SyncReviewSectionId) => {
    const ids = sections[sectionId].map((d) => d.id);
    setSelectedIds(new Set(ids));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const updateDraft = <K extends keyof WalkthroughAnchorSyncDraft>(
    id: string,
    key: K,
    value: WalkthroughAnchorSyncDraft[K],
  ) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, [key]: value } : d)));
  };

  const setReviewStatusForIds = (ids: string[], status: WalkthroughAnchorReviewStatus) => {
    const idSet = new Set(ids);
    setDrafts((prev) =>
      prev.map((d) =>
        idSet.has(d.id)
          ? {
              ...d,
              reviewStatus: status,
              isActive: status === 'approved',
            }
          : d,
      ),
    );
  };

  const handleApproveReady = () => {
    const ids = sections.ready.map((d) => d.id);
    if (ids.length === 0) return;
    setReviewStatusForIds(ids, 'approved');
    onApproveSelected?.(ids);
  };

  const handleRejectReady = () => {
    const ids = sections.ready.map((d) => d.id);
    if (ids.length === 0) return;
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

  const saveDisabled = saving || enrichmentRunning;
  const decidedDrafts = drafts.filter(
    (d) => d.reviewStatus === 'approved' || d.reviewStatus === 'rejected',
  );

  const handleSave = async () => {
    if (enrichmentRunning) return;
    if (decidedDrafts.length === 0) {
      setSaveError('Mark at least one row Approve or Reject before saving.');
      return;
    }
    if (!onSave) {
      onClose();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(decidedDrafts);
      const savedIds = new Set(decidedDrafts.map((d) => d.id));
      setDrafts((prev) => prev.filter((d) => !savedIds.has(d.id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of savedIds) next.delete(id);
        return next;
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save sync review');
    } finally {
      setSaving(false);
    }
  };

  const routes = listWalkthroughRoutes();
  const aiEnrichedCount = sections.ready.length;
  const needsAiCount = sections.needs_ai.length;
  const showNextBatch =
    !!onRunNextAiBatch && needsAiCount > 0 && enrichmentStatus !== 'running';

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
              AI tags in batches of {batchSize}. Select all only selects that section (Ready ≈ this
              batch), not every pending row. Approve/Reject → Save removes decided rows so you can
              keep tagging.
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
              Scans the Apex client for coachable UI surfaces and creates <em>pending</em> catalog
              rows. Tags/routes stay empty until AI (or you) fills them.
            </p>
            <p>
              <strong>What AI smart-tagging does:</strong>
              <br />A Cursor agent reviews up to <em>{batchSize}</em> pending candidates per batch.
              Use <em>Tag next AI batch</em> until scanner-only rows are gone (or you approve/reject
              them). Unsaved AI results are kept when the next batch finishes.
            </p>
            <p>
              <strong>Sections &amp; select all:</strong>
              <br />
              <em>Ready for review</em> — AI-enriched pending rows (typically this batch). Select
              all here only selects that section, not hundreds of still-untagged rows.
              <br />
              <em>Still need AI</em> — scanner-only / awaiting.
              <br />
              <em>Approved / Rejected</em> — local decisions waiting for Save.
            </p>
            <p>
              <strong>Reject + Save:</strong>
              <br />
              Persists as rejected/inactive and is not queued for AI again. Reject without Save stays
              pending and will resurface.
            </p>
          </div>
        )}

        <div className={styles.batchSizeRow} {...{ 'data-testid': 'walkthrough-anchor-sync-batch-size' }}>
          <span className={styles.label}>AI batch size</span>
          <div className={styles.batchSizeOptions}>
            {SMART_TAGGING_BATCH_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                type="button"
                className={
                  batchSize === size
                    ? `${styles.button} ${styles.batchSizeActive}`
                    : `${styles.buttonGhost} ${styles.batchSizeOption}`
                }
                disabled={enrichmentRunning || nextAiBatchPending}
                onClick={() => setBatchSize(size)}
                {...{ 'data-testid': `walkthrough-anchor-sync-batch-size-${size}` }}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        {enrichmentStatus === 'running' && (
          <div {...{ 'data-testid': 'walkthrough-anchor-sync-enrichment-running' }}>
            <p className={styles.warningText}>
              {enrichmentMessage ??
                'AI smart-tagging is running on this batch (tags, route, rationale). Save is disabled until it finishes.'}
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
                'AI smart-tagging finished for this batch. Review Ready for review, then approve/reject and Save.'}
            </p>
            {showNextBatch && (
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={nextAiBatchPending}
                onClick={() => onRunNextAiBatch?.(batchSize)}
                {...{ 'data-testid': 'walkthrough-anchor-sync-next-batch' }}
              >
                {nextAiBatchPending ? 'Starting next AI batch…' : `Tag next AI batch (${batchSize})`}
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
                onClick={() => onRunNextAiBatch?.(batchSize)}
                {...{ 'data-testid': 'walkthrough-anchor-sync-next-batch' }}
              >
                {nextAiBatchPending
                  ? 'Starting next AI batch…'
                  : `Retry / tag next AI batch (${batchSize})`}
              </button>
            )}
          </div>
        )}
        {enrichmentStatus === 'idle' && drafts.length > 0 && (
          <div {...{ 'data-testid': 'walkthrough-anchor-sync-enrichment-idle' }}>
            <p className={styles.hint}>
              {needsAiCount} still need AI · {aiEnrichedCount} ready for review. Empty tags/route
              mean AI has not run on those rows yet.
            </p>
            {showNextBatch && (
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={nextAiBatchPending}
                onClick={() => onRunNextAiBatch?.(batchSize)}
                {...{ 'data-testid': 'walkthrough-anchor-sync-next-batch' }}
              >
                {nextAiBatchPending ? 'Starting next AI batch…' : `Tag next AI batch (${batchSize})`}
              </button>
            )}
          </div>
        )}

        <div className={styles.syncToolbar}>
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
            disabled={sections.ready.length === 0}
            onClick={handleApproveReady}
            {...{ 'data-testid': 'walkthrough-anchor-sync-approve-ready' }}
          >
            Approve ready ({sections.ready.length})
          </button>
          <button
            type="button"
            className={styles.buttonDanger}
            disabled={sections.ready.length === 0}
            onClick={handleRejectReady}
            {...{ 'data-testid': 'walkthrough-anchor-sync-reject-ready' }}
          >
            Reject ready ({sections.ready.length})
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
              {SECTION_ORDER.map((sectionId) => {
                const sectionDrafts = sections[sectionId];
                if (sectionDrafts.length === 0) return null;
                return (
                  <section
                    key={sectionId}
                    className={styles.syncSection}
                    {...{ 'data-testid': `walkthrough-anchor-sync-section-${sectionId}` }}
                  >
                    <div className={styles.syncSectionHeader}>
                      <h3 className={styles.syncSectionTitle}>
                        {SECTION_LABELS[sectionId]}{' '}
                        <span className={styles.hint}>({sectionDrafts.length})</span>
                      </h3>
                      <button
                        type="button"
                        className={styles.buttonGhost}
                        onClick={() => selectSection(sectionId)}
                        {...{
                          'data-testid': `walkthrough-anchor-sync-select-section-${sectionId}`,
                        }}
                      >
                        Select all in section
                      </button>
                    </div>
                    {sectionDrafts.map((draft) => (
                      <SyncDraftRow
                        key={draft.id}
                        draft={draft}
                        selected={selectedIds.has(draft.id)}
                        enrichmentRunning={enrichmentRunning}
                        routes={routes}
                        onToggleSelected={toggleSelected}
                        onUpdate={updateDraft}
                      />
                    ))}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        {saveError && (
          <p
            className={styles.warningText}
            {...{ 'data-testid': 'walkthrough-anchor-sync-save-error' }}
          >
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
            disabled={saveDisabled || decidedDrafts.length === 0}
            title={
              enrichmentRunning
                ? 'Wait for AI smart-tagging to finish before saving'
                : decidedDrafts.length === 0
                  ? 'Approve or reject at least one row before saving'
                  : `Save ${decidedDrafts.length} decided row(s) and remove them from this list`
            }
            {...{ 'data-testid': 'walkthrough-anchor-sync-save' }}
          >
            {saving
              ? 'Saving…'
              : enrichmentRunning
                ? 'Waiting for AI…'
                : `Save decided (${decidedDrafts.length})`}
          </button>
        </div>
      </div>
    </div>
  );
};
