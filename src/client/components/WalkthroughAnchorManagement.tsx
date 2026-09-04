import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  WALKTHROUGH_ANCHOR_REVIEW_STATUSES,
  WALKTHROUGH_ANCHOR_SOURCE_KINDS,
  type WalkthroughAnchorModuleCoverage,
  type WalkthroughAnchorRegistryRecord,
  type WalkthroughAnchorReviewStatus,
  type WalkthroughAnchorSourceKind,
} from '../../shared/types/walkthroughAnchorRegistry';
import {
  WALKTHROUGH_REGISTRY_PLACEMENTS,
  toAuthoringAnchorEntry,
  type WalkthroughAnchorRegistryEntry,
  type WalkthroughRegistryPlacement,
} from '../../shared/walkthroughAnchors';
import { listWalkthroughRoutes } from '../../shared/walkthroughRoutes';
import {
  idsWithRealAiProvenance,
  mergeSmartTaggedSyncCandidates,
  resolveSyncReviewCandidates,
  runChunkedAnchorSmartTagging,
  SMART_TAGGING_BATCH_SIZE_DEFAULT,
  useAnchorRegistryCatalog,
  useAnchorRegistryModuleCoverage,
  useCreateManualAnchor,
  usePersistAnchorSyncReviewDrafts,
  useSoftDeleteAnchor,
  useSyncAnchorRegistry,
  useUpdateAnchorRegistry,
  type SmartTaggingBatchSize,
  type WalkthroughAnchorRegistrySyncResult,
} from '../hooks/usePlatformAdminAnchorRegistry';
import {
  WalkthroughAnchorSyncReviewModal,
  type WalkthroughAnchorSyncDraft,
} from './WalkthroughAnchorSyncReviewModal';
import { useWalkthroughsAiOptions } from '../contexts/WalkthroughsAiOptionsContext';
import { useWalkthroughAnchors } from '../hooks/usePlatformAdminWalkthroughs';
import {
  computeAnchorCatalogCounts,
  filterAnchorCatalog,
  isAnchorCatalogGridRecord,
  type AnchorPresenceFilter,
  WALKTHROUGH_ANCHOR_CATALOG_GRID_STATUSES,
} from './walkthroughAnchorManagementMockData';
import { DataGridToolbar, DataGridFilterSelect } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './WalkthroughAnchorManagement.module.css';

export interface WalkthroughAnchorManagementProps {
  /** Override catalog records (tests). When omitted, loads via useAnchorRegistryCatalog. */
  records?: readonly WalkthroughAnchorRegistryRecord[];
  /**
   * Override sync candidates (tests). When set, Sync skips the sync API and opens
   * the review modal with these rows.
   */
  syncCandidates?: readonly WalkthroughAnchorRegistryRecord[];
  onSyncSave?: (drafts: WalkthroughAnchorSyncDraft[]) => void | Promise<void>;
}

const placementSchema = z.enum(
  WALKTHROUGH_REGISTRY_PLACEMENTS as unknown as [
    WalkthroughRegistryPlacement,
    ...WalkthroughRegistryPlacement[],
  ],
);

const addAnchorSchema = z
  .object({
    anchorKey: z.string().trim().min(1, 'Anchor key is required'),
    testId: z.string().trim().min(1, 'Test ID is required'),
    label: z.string().trim().min(1, 'Label is required'),
    suggestedRoute: z.string().optional(),
    approvedRoute: z.string().optional(),
    allowedPlacements: z.array(placementSchema).min(1, 'Select at least one placement'),
    reviewStatus: z.enum(['pending', 'approved', 'rejected']),
    isActive: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.isActive && values.reviewStatus !== 'approved') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isActive'],
        message: 'Only approved anchors may be active',
      });
    }
  });

type AddAnchorFormValues = z.infer<typeof addAnchorSchema>;

const editAnchorSchema = z
  .object({
    label: z.string().trim().min(1, 'Label is required'),
    suggestedRoute: z.string().optional(),
    approvedRoute: z.string().optional(),
    allowedPlacements: z.array(placementSchema).min(1, 'Select at least one placement'),
    smartTags: z.string().optional(),
    openerAnchorKeys: z.string().optional(),
    reviewStatus: z.enum(['pending', 'approved', 'rejected']),
    isActive: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.isActive && values.reviewStatus !== 'approved') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isActive'],
        message: 'Only approved anchors may be active',
      });
    }
  });

type EditAnchorFormValues = z.infer<typeof editAnchorSchema>;

const ANCHOR_STATUS_SELECT_OPTIONS = WALKTHROUGH_ANCHOR_REVIEW_STATUSES.filter(
  (s) => s !== 'pending',
).map((s) => ({ label: s, value: s as WalkthroughAnchorReviewStatus }));

const ANCHOR_SOURCE_SELECT_OPTIONS = WALKTHROUGH_ANCHOR_SOURCE_KINDS.map((kind) => ({
  label: kind,
  value: kind,
}));

function statusClass(status: WalkthroughAnchorReviewStatus): string {
  if (status === 'approved') return styles.statusApproved;
  if (status === 'pending') return styles.statusPending;
  return styles.statusRejected;
}

function routeFor(record: WalkthroughAnchorRegistryRecord): string {
  return record.approvedRoute ?? record.suggestedRoute ?? '—';
}

function parseSmartTags(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseOpenerAnchorKeys(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

interface ModuleCoverageSummaryProps {
  coverage?: WalkthroughAnchorModuleCoverage;
  isLoading: boolean;
  isError: boolean;
}

const ModuleCoverageSummary: React.FC<ModuleCoverageSummaryProps> = ({
  coverage,
  isLoading,
  isError,
}) => (
  <details
    className={styles.moduleCoverage}
    {...{ 'data-testid': 'walkthrough-module-coverage' }}
  >
    <summary className={styles.moduleCoverageSummary}>
      <span className={styles.moduleCoverageHeading}>
        <span className={styles.moduleCoverageTitle}>Module coverage</span>
        <span className={styles.moduleCoverageHint}>
          Approved, active, present anchors across user-facing modules
        </span>
      </span>
      <span className={styles.moduleCoverageMetrics}>
        {isLoading ? (
          <span className={styles.moduleCoverageState}>Loading…</span>
        ) : isError || !coverage ? (
          <span className={styles.moduleCoverageState}>Unavailable</span>
        ) : (
          <>
            <span
              className={styles.moduleCoverageCount}
              {...{ 'data-testid': 'walkthrough-module-coverage-count' }}
            >
              {coverage.coveredCount} of {coverage.totalModules} covered
            </span>
            <span className={styles.moduleCoverageNeeds}>
              {coverage.uncoveredCount} module{coverage.uncoveredCount === 1 ? '' : 's'}{' '}
              need{coverage.uncoveredCount === 1 ? 's' : ''} anchors
            </span>
          </>
        )}
        <span className={styles.moduleCoverageChevron} aria-hidden="true" />
      </span>
    </summary>
    {coverage && (
      <div className={styles.moduleCoverageContent}>
        <section className={styles.moduleCoverageSection}>
          <div className={styles.moduleCoverageSectionHeader}>
            <h3 className={styles.moduleCoverageSectionTitle}>
              Needs anchors ({coverage.uncoveredCount})
            </h3>
            <p className={styles.moduleCoverageSectionHint}>
              Add stable, static data-testid values, then run Sync.
            </p>
          </div>
          <ul className={styles.moduleList}>
            {coverage.uncoveredModules.map((module) => (
              <li
                key={module.key}
                className={styles.moduleRowUncovered}
                {...{ 'data-testid': `walkthrough-module-uncovered-${module.key}` }}
              >
                <span className={styles.moduleName}>{module.label}</span>
                <span className={styles.moduleRoutes}>{module.routes.join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className={styles.moduleCoverageSection}>
          <div className={styles.moduleCoverageSectionHeader}>
            <h3 className={styles.moduleCoverageSectionTitle}>
              Covered ({coverage.coveredCount})
            </h3>
            <p className={styles.moduleCoverageSectionHint}>
              Number of approved anchors currently available to walkthroughs.
            </p>
          </div>
          <ul className={styles.moduleList}>
            {coverage.coveredModules.map((module) => (
              <li
                key={module.key}
                className={styles.moduleRowCovered}
                {...{ 'data-testid': `walkthrough-module-covered-${module.key}` }}
              >
                <span className={styles.moduleName}>{module.label}</span>
                <span className={styles.moduleAnchorCount}>
                  {module.anchorCount} anchor{module.anchorCount === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    )}
  </details>
);

interface AddAnchorModalProps {
  onClose: () => void;
  onCreated?: () => void;
}

const AddAnchorModal: React.FC<AddAnchorModalProps> = ({ onClose, onCreated }) => {
  const createMutation = useCreateManualAnchor();
  const routes = listWalkthroughRoutes();

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<AddAnchorFormValues>({
    resolver: zodResolver(addAnchorSchema),
    defaultValues: {
      anchorKey: '',
      testId: '',
      label: '',
      suggestedRoute: '',
      approvedRoute: '',
      allowedPlacements: [...WALKTHROUGH_REGISTRY_PLACEMENTS],
      reviewStatus: 'approved',
      isActive: true,
    },
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch() is intentionally unmemoizable
  const reviewStatus = watch('reviewStatus');
  const placements = watch('allowedPlacements');

  useEffect(() => {
    if (reviewStatus !== 'approved') {
      setValue('isActive', false);
    }
  }, [reviewStatus, setValue]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !createMutation.isPending) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, createMutation.isPending]);

  const togglePlacement = (placement: WalkthroughRegistryPlacement) => {
    const next = placements.includes(placement)
      ? placements.filter((p) => p !== placement)
      : [...placements, placement];
    setValue('allowedPlacements', next, { shouldValidate: true });
  };

  const onSubmit = async (values: AddAnchorFormValues) => {
    try {
      await createMutation.mutateAsync({
        anchorKey: values.anchorKey.trim(),
        testId: values.testId.trim(),
        label: values.label.trim(),
        suggestedRoute: emptyToNull(values.suggestedRoute),
        approvedRoute: emptyToNull(values.approvedRoute),
        allowedPlacements: values.allowedPlacements,
        reviewStatus: values.reviewStatus,
        isActive: values.reviewStatus === 'approved' ? values.isActive : false,
      });
      onCreated?.();
      onClose();
    } catch {
      // surfaced via createMutation.error
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- overlay dismiss; Escape handled separately
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !createMutation.isPending) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="anchor-add-title"
      {...{ 'data-testid': 'walkthrough-anchor-add-modal' }}
    >
      <div className={styles.modalCardNarrow}>
        <div className={styles.modalHeader}>
          <div>
            <h2 className={styles.modalTitle} id="anchor-add-title">
              Add New Anchor
            </h2>
            <p className={styles.modalHint}>
              Manual Super Admin create. Active requires approved review status.
            </p>
          </div>
        </div>
        <form
          className={styles.syncFields}
          onSubmit={handleSubmit(onSubmit)}
          {...{ 'data-testid': 'walkthrough-anchor-add-form' }}
        >
          <label className={styles.field}>
            <span className={styles.label}>Anchor key</span>
            <input
              className={styles.input}
              placeholder="e.g. feature-request-fab"
              {...register('anchorKey')}
              {...{ 'data-testid': 'walkthrough-anchor-add-key' }}
            />
            {errors.anchorKey && (
              <span className={styles.warningText}>{errors.anchorKey.message}</span>
            )}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Test ID</span>
            <input
              className={styles.input}
              placeholder="data-testid value"
              {...register('testId')}
              {...{ 'data-testid': 'walkthrough-anchor-add-testid' }}
            />
            <span className={styles.fieldHint}>
              Must match the element&apos;s existing{' '}
              <code className={styles.dependencyCode}>data-testid</code> — anchors cannot target
              elements without one.
            </span>
            {errors.testId && (
              <span className={styles.warningText}>{errors.testId.message}</span>
            )}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Label</span>
            <input
              className={styles.input}
              placeholder="Authoring label"
              {...register('label')}
              {...{ 'data-testid': 'walkthrough-anchor-add-label' }}
            />
            {errors.label && (
              <span className={styles.warningText}>{errors.label.message}</span>
            )}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Suggested route</span>
            <select
              className={styles.select}
              {...register('suggestedRoute')}
              {...{ 'data-testid': 'walkthrough-anchor-add-suggested-route' }}
            >
              <option value="">None</option>
              {routes.map((r) => (
                <option key={r.route} value={r.route}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Approved route</span>
            <select
              className={styles.select}
              {...register('approvedRoute')}
              {...{ 'data-testid': 'walkthrough-anchor-add-approved-route' }}
            >
              <option value="">None</option>
              {routes.map((r) => (
                <option key={r.route} value={r.route}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Review status</span>
            <select
              className={styles.select}
              {...register('reviewStatus')}
              {...{ 'data-testid': 'walkthrough-anchor-add-review-status' }}
            >
              {WALKTHROUGH_ANCHOR_REVIEW_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.label}>Placements</span>
            <div className={styles.placementChecks}>
              {WALKTHROUGH_REGISTRY_PLACEMENTS.map((placement) => (
                <label key={placement} className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={placements.includes(placement)}
                    onChange={() => togglePlacement(placement)}
                    {...{
                      'data-testid': `walkthrough-anchor-add-placement-${placement}`,
                    }}
                  />
                  {placement}
                </label>
              ))}
            </div>
            {errors.allowedPlacements && (
              <span className={styles.warningText}>{errors.allowedPlacements.message}</span>
            )}
          </div>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              disabled={reviewStatus !== 'approved'}
              {...register('isActive')}
              {...{ 'data-testid': 'walkthrough-anchor-add-active' }}
            />
            Active (requires approved)
          </label>
          {errors.isActive && (
            <span className={styles.warningText}>{errors.isActive.message}</span>
          )}
          {createMutation.error && (
            <p
              className={styles.warningText}
              {...{ 'data-testid': 'walkthrough-anchor-add-error' }}
            >
              {createMutation.error.message}
            </p>
          )}
          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.button}
              onClick={onClose}
              disabled={createMutation.isPending}
              {...{ 'data-testid': 'walkthrough-anchor-add-cancel' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.buttonPrimary}
              disabled={createMutation.isPending}
              {...{ 'data-testid': 'walkthrough-anchor-add-save' }}
            >
              {createMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface EditAnchorModalProps {
  record: WalkthroughAnchorRegistryRecord;
  availableOpeners: readonly WalkthroughAnchorRegistryEntry[];
  onClose: () => void;
}

const EditAnchorModal: React.FC<EditAnchorModalProps> = ({
  record,
  availableOpeners,
  onClose,
}) => {
  const updateMutation = useUpdateAnchorRegistry();
  const routes = listWalkthroughRoutes();
  const [openerRoute, setOpenerRoute] = useState('');
  const [openerSearch, setOpenerSearch] = useState('');

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<EditAnchorFormValues>({
    resolver: zodResolver(editAnchorSchema),
    defaultValues: {
      label: record.label,
      suggestedRoute: record.suggestedRoute ?? '',
      approvedRoute: record.approvedRoute ?? '',
      allowedPlacements: [...record.allowedPlacements],
      smartTags: record.smartTags.join(', '),
      openerAnchorKeys: (record.openerAnchorKeys ?? []).join(', '),
      reviewStatus: record.reviewStatus,
      isActive: record.isActive,
    },
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch() is intentionally unmemoizable
  const reviewStatus = watch('reviewStatus');
  const placements = watch('allowedPlacements');
  const selectedOpenerKeys = parseOpenerAnchorKeys(watch('openerAnchorKeys'));
  const openerByKey = useMemo(
    () => new Map(availableOpeners.map((candidate) => [candidate.key, candidate])),
    [availableOpeners],
  );
  const filteredOpeners = useMemo(() => {
    const term = openerSearch.trim().toLowerCase();
    return availableOpeners
      .filter((candidate) => candidate.key !== record.anchorKey)
      .filter((candidate) => {
        if (!openerRoute) return true;
        return candidate.targetRoute === openerRoute;
      })
      .filter((candidate) => {
        if (!term) return true;
        return [
          candidate.label,
          candidate.key,
          candidate.testId,
          ...(candidate.smartTags ?? []),
        ]
          .join(' ')
          .toLowerCase()
          .includes(term);
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [availableOpeners, openerRoute, openerSearch, record.anchorKey]);

  useEffect(() => {
    if (reviewStatus !== 'approved') {
      setValue('isActive', false);
    }
  }, [reviewStatus, setValue]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !updateMutation.isPending) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, updateMutation.isPending]);

  const togglePlacement = (placement: WalkthroughRegistryPlacement) => {
    const next = placements.includes(placement)
      ? placements.filter((p) => p !== placement)
      : [...placements, placement];
    setValue('allowedPlacements', next, { shouldValidate: true });
  };

  const setSelectedOpeners = (keys: readonly string[]) => {
    setValue('openerAnchorKeys', keys.join(', '), {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const toggleOpener = (key: string) => {
    setSelectedOpeners(
      selectedOpenerKeys.includes(key)
        ? selectedOpenerKeys.filter((selected) => selected !== key)
        : [...selectedOpenerKeys, key],
    );
  };

  const moveOpener = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= selectedOpenerKeys.length) return;
    const next = [...selectedOpenerKeys];
    [next[index], next[target]] = [next[target], next[index]];
    setSelectedOpeners(next);
  };

  const onSubmit = async (values: EditAnchorFormValues) => {
    try {
      await updateMutation.mutateAsync({
        id: record.id,
        label: values.label.trim(),
        suggestedRoute: emptyToNull(values.suggestedRoute),
        approvedRoute: emptyToNull(values.approvedRoute),
        allowedPlacements: values.allowedPlacements,
        smartTags: parseSmartTags(values.smartTags),
        openerAnchorKeys: parseOpenerAnchorKeys(values.openerAnchorKeys),
        reviewStatus: values.reviewStatus,
        isActive: values.reviewStatus === 'approved' ? values.isActive : false,
      });
      onClose();
    } catch {
      // surfaced via updateMutation.error
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- overlay dismiss; Escape handled separately
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !updateMutation.isPending) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="anchor-edit-title"
      {...{ 'data-testid': 'walkthrough-anchor-edit-modal' }}
    >
      <div className={styles.modalCardEditor}>
        <div className={styles.modalHeader}>
          <div>
            <h2 className={styles.modalTitle} id="anchor-edit-title">
              Edit Anchor
            </h2>
            <p className={styles.modalHint}>
              {record.anchorKey} · testid: {record.testId}
            </p>
          </div>
        </div>
        <form
          className={styles.syncFields}
          onSubmit={handleSubmit(onSubmit)}
          {...{ 'data-testid': 'walkthrough-anchor-edit-form' }}
        >
          <label className={styles.field}>
            <span className={styles.label}>Label</span>
            <input
              className={styles.input}
              {...register('label')}
              {...{ 'data-testid': 'walkthrough-anchor-edit-label' }}
            />
            {errors.label && (
              <span className={styles.warningText}>{errors.label.message}</span>
            )}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Suggested route</span>
            <select
              className={styles.select}
              {...register('suggestedRoute')}
              {...{ 'data-testid': 'walkthrough-anchor-edit-suggested-route' }}
            >
              <option value="">None</option>
              {routes.map((r) => (
                <option key={r.route} value={r.route}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Approved route</span>
            <select
              className={styles.select}
              {...register('approvedRoute')}
              {...{ 'data-testid': 'walkthrough-anchor-edit-approved-route' }}
            >
              <option value="">None</option>
              {routes.map((r) => (
                <option key={r.route} value={r.route}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Review status</span>
            <select
              className={styles.select}
              {...register('reviewStatus')}
              {...{ 'data-testid': 'walkthrough-anchor-edit-review-status' }}
            >
              {WALKTHROUGH_ANCHOR_REVIEW_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.label}>Tags (comma-separated)</span>
            <input
              className={styles.input}
              {...register('smartTags')}
              {...{ 'data-testid': 'walkthrough-anchor-edit-tags' }}
            />
          </label>
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.label}>Opener anchors (ordered)</span>
            <span className={styles.modalHint}>
              Select approved+active elements to click before this hidden target appears. AI uses
              this reveal chain during generation. Leave empty when the target is already visible.
            </span>

            {selectedOpenerKeys.length > 0 ? (
              <ol
                className={styles.openerSelection}
                {...{ 'data-testid': 'walkthrough-anchor-edit-openers' }}
              >
                {selectedOpenerKeys.map((key, index) => {
                  const selected = openerByKey.get(key);
                  return (
                    <li key={key} className={styles.openerSelectionRow}>
                      <span className={styles.openerSelectionText}>
                        <strong>{selected?.label ?? key}</strong>
                        <code>{key}</code>
                      </span>
                      <span className={styles.openerSelectionActions}>
                        <button
                          type="button"
                          className={styles.buttonGhost}
                          aria-label={`Move opener ${key} up`}
                          disabled={index === 0}
                          onClick={() => moveOpener(index, -1)}
                          {...{ 'data-testid': `walkthrough-anchor-edit-opener-move-up-${key}` }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className={styles.buttonGhost}
                          aria-label={`Move opener ${key} down`}
                          disabled={index === selectedOpenerKeys.length - 1}
                          onClick={() => moveOpener(index, 1)}
                          {...{ 'data-testid': `walkthrough-anchor-edit-opener-move-down-${key}` }}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className={styles.buttonGhost}
                          onClick={() => toggleOpener(key)}
                          {...{ 'data-testid': `walkthrough-anchor-edit-opener-remove-${key}` }}
                        >
                          Remove
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p
                className={styles.openerEmpty}
                {...{ 'data-testid': 'walkthrough-anchor-edit-openers' }}
              >
                No opener anchors selected.
              </p>
            )}

            <div className={styles.openerFilters}>
              <label className={styles.field}>
                <span className={styles.label}>Filter by route</span>
                <select
                  className={styles.select}
                  value={openerRoute}
                  onChange={(event) => setOpenerRoute(event.target.value)}
                  {...{ 'data-testid': 'walkthrough-anchor-edit-opener-route-filter' }}
                >
                  <option value="">All routes</option>
                  {routes.map((route) => (
                    <option key={route.route} value={route.route}>
                      {route.label} ({route.route})
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Search openers</span>
                <input
                  type="search"
                  className={styles.input}
                  placeholder="Label, key, test ID, or tag…"
                  value={openerSearch}
                  onChange={(event) => setOpenerSearch(event.target.value)}
                  {...{ 'data-testid': 'walkthrough-anchor-edit-opener-search' }}
                />
              </label>
            </div>

            <div
              className={styles.openerOptions}
              {...{ 'data-testid': 'walkthrough-anchor-edit-opener-options' }}
            >
              {filteredOpeners.length > 0 ? (
                filteredOpeners.map((candidate) => (
                  <label key={candidate.key} className={styles.openerOption}>
                    <input
                      type="checkbox"
                      checked={selectedOpenerKeys.includes(candidate.key)}
                      onChange={() => toggleOpener(candidate.key)}
                      {...{
                        'data-testid': `walkthrough-anchor-edit-opener-option-${candidate.key}`,
                      }}
                    />
                    <span>
                      <strong>{candidate.label}</strong>
                      <small>
                        {candidate.key} · {candidate.testId} ·{' '}
                        {candidate.targetRoute || 'Any route'}
                      </small>
                    </span>
                  </label>
                ))
              ) : (
                <p className={styles.openerEmpty}>No approved openers match these filters.</p>
              )}
            </div>
            <span className={styles.modalHint}>
              Selection order is click order. For example, an Add button can reveal a modal Save
              button. Test both Next and Back after saving.
            </span>
          </div>
          <div className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.label}>Placements</span>
            <div className={styles.placementChecks}>
              {WALKTHROUGH_REGISTRY_PLACEMENTS.map((placement) => (
                <label key={placement} className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={placements.includes(placement)}
                    onChange={() => togglePlacement(placement)}
                    {...{
                      'data-testid': `walkthrough-anchor-edit-placement-${placement}`,
                    }}
                  />
                  {placement}
                </label>
              ))}
            </div>
            {errors.allowedPlacements && (
              <span className={styles.warningText}>{errors.allowedPlacements.message}</span>
            )}
          </div>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              disabled={reviewStatus !== 'approved'}
              {...register('isActive')}
              {...{ 'data-testid': 'walkthrough-anchor-edit-active' }}
            />
            Active (requires approved)
          </label>
          {errors.isActive && (
            <span className={styles.warningText}>{errors.isActive.message}</span>
          )}
          {updateMutation.error && (
            <p
              className={styles.warningText}
              {...{ 'data-testid': 'walkthrough-anchor-edit-error' }}
            >
              {updateMutation.error.message}
            </p>
          )}
          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.button}
              onClick={onClose}
              disabled={updateMutation.isPending}
              {...{ 'data-testid': 'walkthrough-anchor-edit-cancel' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.buttonPrimary}
              disabled={updateMutation.isPending}
              {...{ 'data-testid': 'walkthrough-anchor-edit-save' }}
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

interface DeleteAnchorModalProps {
  record: WalkthroughAnchorRegistryRecord;
  onClose: () => void;
}

const DeleteAnchorModal: React.FC<DeleteAnchorModalProps> = ({ record, onClose }) => {
  const deleteMutation = useSoftDeleteAnchor();

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleteMutation.isPending) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, deleteMutation.isPending]);

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync({ id: record.id });
      onClose();
    } catch {
      // surfaced via deleteMutation.error
    }
  };

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- overlay dismiss; Escape handled separately
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !deleteMutation.isPending) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="anchor-delete-title"
      {...{ 'data-testid': 'walkthrough-anchor-delete-modal' }}
    >
      <div className={styles.modalCardNarrow}>
        <div className={styles.modalHeader}>
          <div>
            <h2 className={styles.modalTitle} id="anchor-delete-title">
              Soft-delete Anchor
            </h2>
            <p className={styles.modalHint}>
              Soft-delete <strong>{record.label}</strong> ({record.anchorKey})? It will leave
              the live catalog but remain recoverable via includeDeleted.
            </p>
          </div>
        </div>
        {deleteMutation.error && (
          <p
            className={styles.warningText}
            {...{ 'data-testid': 'walkthrough-anchor-delete-error' }}
          >
            {deleteMutation.error.message}
          </p>
        )}
        <div className={styles.modalFooter}>
          <button
            type="button"
            className={styles.button}
            onClick={onClose}
            disabled={deleteMutation.isPending}
            {...{ 'data-testid': 'walkthrough-anchor-delete-cancel' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.buttonDanger}
            onClick={() => void handleDelete()}
            disabled={deleteMutation.isPending}
            {...{ 'data-testid': 'walkthrough-anchor-delete-confirm' }}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const WalkthroughAnchorManagement: React.FC<WalkthroughAnchorManagementProps> = ({
  records: recordsProp,
  syncCandidates: syncCandidatesProp,
  onSyncSave,
}) => {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | WalkthroughAnchorReviewStatus>('all');
  const [route, setRoute] = useState('');
  const [source, setSource] = useState<'all' | WalkthroughAnchorSourceKind>('all');
  const [presence, setPresence] = useState<AnchorPresenceFilter>('all');
  const [syncOpen, setSyncOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<WalkthroughAnchorRegistryRecord | null>(null);
  const [deleting, setDeleting] = useState<WalkthroughAnchorRegistryRecord | null>(null);
  const [liveSyncCandidates, setLiveSyncCandidates] = useState<
    WalkthroughAnchorRegistryRecord[]
  >([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [enrichmentStatus, setEnrichmentStatus] = useState<
    'idle' | 'running' | 'ready' | 'failed'
  >('idle');
  const [enrichmentMessage, setEnrichmentMessage] = useState<string | null>(null);
  const [smartTaggingBatchSize, setSmartTaggingBatchSize] = useState<SmartTaggingBatchSize>(
    SMART_TAGGING_BATCH_SIZE_DEFAULT,
  );
  const smartTaggingAbortRef = useRef<AbortController | null>(null);
  /** Latest Sync result, so refine can reuse its candidate ids without re-scanning. */
  const lastSyncResultRef = useRef<WalkthroughAnchorRegistrySyncResult | null>(null);
  const { anchorSmartTaggingModel, anchorSmartTaggingSkillPath } = useWalkthroughsAiOptions();

  useEffect(() => {
    return () => {
      smartTaggingAbortRef.current?.abort();
    };
  }, []);

  const useLiveCatalog = recordsProp === undefined;

  const listParams = useMemo(
    () => ({
      search: search.trim() || undefined,
      reviewStatus:
        status === 'all'
          ? [...WALKTHROUGH_ANCHOR_CATALOG_GRID_STATUSES]
          : status,
      sourceKind: source === 'all' ? undefined : source,
      approvedRoute: route || undefined,
      missingOnly: presence === 'missing' ? true : undefined,
      limit: 200,
    }),
    [search, status, source, route, presence],
  );

  const catalogQuery = useAnchorRegistryCatalog(listParams, { enabled: useLiveCatalog });
  const coverageQuery = useAnchorRegistryModuleCoverage({ enabled: useLiveCatalog });
  const authoringAnchorsQuery = useWalkthroughAnchors();
  const syncMutation = useSyncAnchorRegistry();
  const persistSyncReviewMutation = usePersistAnchorSyncReviewDrafts();

  // eslint-disable-next-line react-hooks/exhaustive-deps -- fallback [] is render-local; memo deps intentionally include records identity
  const records = recordsProp ?? catalogQuery.data?.items ?? [];
  const availableOpeners = useMemo(
    () =>
      authoringAnchorsQuery.data ??
      records
        .filter(
          (candidate) =>
            candidate.reviewStatus === 'approved' &&
            candidate.isActive &&
            candidate.deletedAt == null,
        )
        .map((candidate) =>
          toAuthoringAnchorEntry({
            ...candidate,
            targetRoute: candidate.approvedRoute ?? candidate.suggestedRoute,
          }),
        ),
    [authoringAnchorsQuery.data, records],
  );

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- keep manual memo; records fallback identity is intentional
  const counts = useMemo(() => {
    const gridRecords = records.filter(isAnchorCatalogGridRecord);
    if (!useLiveCatalog || !catalogQuery.data?.counts) {
      return computeAnchorCatalogCounts(gridRecords);
    }
    const apiCounts = catalogQuery.data.counts;
    return {
      total: apiCounts.total,
      approved: apiCounts.approved,
      pending: apiCounts.pending,
      rejected: apiCounts.rejected,
      missing: apiCounts.missing,
      present: Math.max(0, apiCounts.total - apiCounts.missing),
    };
  }, [useLiveCatalog, catalogQuery.data?.counts, records]);

  const filtered = useMemo(() => {
    if (useLiveCatalog) {
      // Server already applied search/status/source/route/missingOnly; finish presence=present locally.
      if (presence === 'present') {
        return records.filter((r) => r.missingSince == null && r.lastSeenAt != null);
      }
      return [...records];
    }
    return filterAnchorCatalog(records, {
      search,
      status,
      route,
      source,
      presence,
    });
  }, [useLiveCatalog, records, presence, search, status, route, source]);

  const routes = listWalkthroughRoutes();

  const reviewCandidates =
    syncCandidatesProp !== undefined ? syncCandidatesProp : liveSyncCandidates;

  const runSmartTaggingForSyncResult = (
    result: WalkthroughAnchorRegistrySyncResult,
    options: {
      batchSize: SmartTaggingBatchSize;
      excludeIds: readonly string[];
    },
  ) => {
    smartTaggingAbortRef.current?.abort();
    const abort = new AbortController();
    smartTaggingAbortRef.current = abort;
    const pendingIds = (result.persistence?.newCandidateIdsForSmartTagging ?? []).filter(
      (id) => !options.excludeIds.includes(id),
    );
    if (pendingIds.length === 0) {
      setEnrichmentStatus('idle');
      setEnrichmentMessage(
        'No additional candidates need AI — review Ready rows, or Save decided ones.',
      );
      return;
    }
    const numericBatch =
      options.batchSize === 'all' ? pendingIds.length : options.batchSize;
    const batchSize = Math.min(numericBatch, pendingIds.length);
    const remainingAfterBatch = Math.max(0, pendingIds.length - batchSize);
    setEnrichmentStatus('running');
    setEnrichmentMessage(
      `Background AI refine queued: ${batchSize} of ${pendingIds.length} uncertain row(s). Save stays enabled.`,
    );
    void runChunkedAnchorSmartTagging(result, {
      signal: abort.signal,
      model: anchorSmartTaggingModel.trim() || undefined,
      skillPath: anchorSmartTaggingSkillPath.trim() || undefined,
      batchSize,
      excludeIds: options.excludeIds,
      onProgress: ({ elapsedMs, totalChunks, completedChunks, runningChunks, updatedCount }) => {
        if (abort.signal.aborted) return;
        const elapsedSec = Math.floor(elapsedMs / 1000);
        const elapsedLabel =
          elapsedSec < 60
            ? `${elapsedSec}s`
            : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
        const chunkLabel =
          totalChunks > 1
            ? ` — batch ${completedChunks}/${totalChunks} done (${runningChunks} running), ${updatedCount} tagged so far`
            : '';
        setEnrichmentMessage(
          `AI smart-tagging running: ${batchSize} anchor(s) of ${pendingIds.length} awaiting AI${chunkLabel}. Elapsed ${elapsedLabel}.`,
        );
      },
    })
      .then((status) => {
        if (abort.signal.aborted) return;
        if (!status) {
          setEnrichmentStatus('idle');
          return;
        }
        if (status.status === 'ready' && status.updated?.length) {
          setLiveSyncCandidates((prev) =>
            mergeSmartTaggedSyncCandidates(prev, status.updated),
          );
          setEnrichmentStatus('ready');
          const base =
            remainingAfterBatch > 0
              ? `AI updated ${status.updated.length} candidate(s) in this batch. ${remainingAfterBatch} still await AI — use Tag next AI batch for up to ${options.batchSize} more.`
              : `AI smart-tagging updated ${status.updated.length} candidate(s). Review Ready for review, then approve/reject and Save.`;
          setEnrichmentMessage(status.warning ? `${base} ${status.warning}` : base);
          return;
        }
        if (status.status === 'ready') {
          setEnrichmentStatus('ready');
          const base =
            remainingAfterBatch > 0
              ? `AI finished this batch with no field changes. ${remainingAfterBatch} still await AI — use Tag next AI batch.`
              : 'AI smart-tagging finished; no additional metadata changes.';
          setEnrichmentMessage(status.warning ? `${base} ${status.warning}` : base);
          return;
        }
        setEnrichmentStatus('failed');
        // Prefer the specific failure reason; keep the reviewable warning as context.
        const detail = [status.error, status.warning].filter(Boolean).join(' — ');
        setEnrichmentMessage(
          detail ||
            'AI smart-tagging did not finish. Tags/route stay empty until you Sync again or edit manually.',
        );
      })
      .catch((err) => {
        if (abort.signal.aborted) return;
        setEnrichmentStatus('failed');
        setEnrichmentMessage(
          err instanceof Error
            ? err.message
            : 'AI smart-tagging failed. Tags/route stay empty until you Sync again or edit manually.',
        );
      });
  };

  /** Sync scans + classifies only. Background AI never starts here — see handleRefineUncertain. */
  const handleSyncClick = async () => {
    setActionError(null);
    setEnrichmentStatus('idle');
    setEnrichmentMessage(null);
    if (syncCandidatesProp !== undefined) {
      setSyncOpen(true);
      return;
    }
    try {
      const result = await syncMutation.mutateAsync();
      lastSyncResultRef.current = result;
      setLiveSyncCandidates(resolveSyncReviewCandidates(result));
      setSyncOpen(true);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Sync failed. The sync endpoint may not be available yet.';
      setActionError(message);
      const pending = records.filter((r) => r.reviewStatus === 'pending');
      if (pending.length > 0) {
        setLiveSyncCandidates(pending);
        setSyncOpen(true);
      }
    }
  };

  /** Only entry point that queues background AI — requires an explicit click in the modal. */
  const handleRefineUncertain = (batchSize: SmartTaggingBatchSize) => {
    const result = lastSyncResultRef.current;
    if (!result) {
      setEnrichmentStatus('failed');
      setEnrichmentMessage(
        'Run Sync first — refine needs the candidate ids from the latest sync.',
      );
      return;
    }
    runSmartTaggingForSyncResult(result, {
      batchSize,
      excludeIds: idsWithRealAiProvenance(liveSyncCandidates),
    });
  };

  const handleSyncSave = async (drafts: WalkthroughAnchorSyncDraft[]) => {
    if (onSyncSave) {
      await onSyncSave(drafts);
    } else {
      // Field + review persist only — never re-runs Sync / data-testid scan.
      await persistSyncReviewMutation.mutateAsync({
        drafts,
        originals: liveSyncCandidates,
      });
    }
    const savedIds = new Set(drafts.map((d) => d.id));
    setLiveSyncCandidates((prev) => prev.filter((row) => !savedIds.has(row.id)));
  };

  const catalogLoading = useLiveCatalog && catalogQuery.isLoading;
  const catalogError =
    useLiveCatalog && catalogQuery.isError
      ? catalogQuery.error instanceof Error
        ? catalogQuery.error.message
        : 'Failed to load anchor catalog'
      : null;

  return (
    <section
      className={gridStyles.section}
      {...{ 'data-testid': 'walkthrough-anchor-management' }}
    >
      <div className={gridStyles.header}>
        <div>
          <h2 className={gridStyles.title}>Anchor Management</h2>
          <p className={gridStyles.hint}>
            Review and maintain the walkthrough anchor catalog. Sync discovers candidates;
            approved+active rows become the runtime allow-list.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => void handleSyncClick()}
            disabled={syncMutation.isPending}
            {...{ 'data-testid': 'walkthrough-anchor-sync' }}
          >
            {syncMutation.isPending ? 'Syncing…' : 'Sync'}
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            onClick={() => setAddOpen(true)}
            {...{ 'data-testid': 'walkthrough-anchor-add-new' }}
          >
            Add New
          </button>
        </div>
      </div>

      <aside
        className={styles.dependencyNotice}
        {...{ 'data-testid': 'walkthrough-anchor-testid-dependency' }}
      >
        <strong className={styles.dependencyNoticeLabel}>Hard dependency:</strong>{' '}
        Coachable elements must expose a stable, static{' '}
        <code className={styles.dependencyCode}>data-testid</code> on the DOM node you want to
        target. Sync only discovers those values, and walkthrough coachmarks resolve to them at
        runtime — CSS selectors or unlabeled elements cannot be chosen.
      </aside>

      {(actionError || catalogError) && (
        <p
          className={styles.warningText}
          {...{ 'data-testid': 'walkthrough-anchor-action-error' }}
        >
          {actionError ?? catalogError}
        </p>
      )}

      <div className={styles.counts} {...{ 'data-testid': 'walkthrough-anchor-counts' }}>
        <span className={styles.countChip}>
          Total <span className={styles.countValue}>{counts.total}</span>
        </span>
        <span className={styles.countChip}>
          Approved <span className={styles.countValue}>{counts.approved}</span>
        </span>
        <span className={styles.countChip}>
          Rejected <span className={styles.countValue}>{counts.rejected}</span>
        </span>
        <span className={styles.countChip}>
          Present <span className={styles.countValue}>{counts.present}</span>
        </span>
        <span className={styles.countMissing}>
          Missing <span className={styles.countValue}>{counts.missing}</span>
        </span>
      </div>

      <ModuleCoverageSummary
        coverage={coverageQuery.data}
        isLoading={useLiveCatalog && coverageQuery.isLoading}
        isError={useLiveCatalog && coverageQuery.isError}
      />

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Key, label, tag, or file…"
        searchTestId="walkthrough-anchor-search"
      >
        <DataGridFilterSelect
          label="Status"
          value={status === 'all' ? '' : status}
          onChange={(v) =>
            setStatus((v === '' ? 'all' : v) as 'all' | WalkthroughAnchorReviewStatus)
          }
          options={ANCHOR_STATUS_SELECT_OPTIONS}
          includeEmptyOption
          emptyOptionLabel="All statuses"
          testId="walkthrough-anchor-filter-status"
          {...{ 'data-testid': 'walkthrough-anchor-filter-status' }}
        />
        <DataGridFilterSelect
          label="Route"
          value={route}
          onChange={setRoute}
          options={routes.map((r) => ({ label: r.label, value: r.route }))}
          includeEmptyOption
          emptyOptionLabel="All routes"
          testId="walkthrough-anchor-filter-route"
          {...{ 'data-testid': 'walkthrough-anchor-filter-route' }}
        />
        <DataGridFilterSelect
          label="Source"
          value={source === 'all' ? '' : source}
          onChange={(v) =>
            setSource((v === '' ? 'all' : v) as 'all' | WalkthroughAnchorSourceKind)
          }
          options={ANCHOR_SOURCE_SELECT_OPTIONS}
          includeEmptyOption
          emptyOptionLabel="All sources"
          testId="walkthrough-anchor-filter-source"
          {...{ 'data-testid': 'walkthrough-anchor-filter-source' }}
        />
        <DataGridFilterSelect
          label="Presence"
          value={presence === 'all' ? '' : presence}
          onChange={(v) => setPresence((v === '' ? 'all' : v) as AnchorPresenceFilter)}
          options={[
            { label: 'Present', value: 'present' },
            { label: 'Missing', value: 'missing' },
          ]}
          includeEmptyOption
          emptyOptionLabel="All"
          testId="walkthrough-anchor-filter-presence"
          {...{ 'data-testid': 'walkthrough-anchor-filter-presence' }}
        />
      </DataGridToolbar>

      {catalogLoading ? (
        <p className={gridStyles.empty} {...{ 'data-testid': 'walkthrough-anchor-loading' }}>
          Loading anchors…
        </p>
      ) : filtered.length === 0 ? (
        <p className={gridStyles.empty} {...{ 'data-testid': 'walkthrough-anchor-empty' }}>
          No anchors match the current filters.
        </p>
      ) : (
        <div className={gridStyles.tableWrap}>
          <table className={gridStyles.table} {...{ 'data-testid': 'walkthrough-anchor-table' }}>
            <thead>
              <tr>
                <th scope="col">Anchor</th>
                <th scope="col">Status</th>
                <th scope="col">Route</th>
                <th scope="col">Tags</th>
                <th scope="col">Placements</th>
                <th scope="col">Source</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((record) => {
                const isMissing = record.missingSince != null;
                return (
                  <tr
                    key={record.id}
                    {...{ 'data-testid': `walkthrough-anchor-row-${record.id}` }}
                  >
                    <td>
                      <span className={styles.anchorKey}>{record.label}</span>
                      <span className={styles.testId}>{record.anchorKey}</span>
                      <span className={styles.testId}>testid: {record.testId}</span>
                    </td>
                    <td>
                      <span className={statusClass(record.reviewStatus)}>
                        {record.reviewStatus}
                      </span>
                      {isMissing ? (
                        <span
                          className={styles.presenceMissing}
                          {...{ 'data-testid': `walkthrough-anchor-missing-${record.id}` }}
                        >
                          missing
                        </span>
                      ) : (
                        <span className={styles.presenceBadge}>present</span>
                      )}
                      {isMissing && (
                        <p className={styles.warningText}>
                          Missing since {new Date(record.missingSince!).toLocaleString()}
                        </p>
                      )}
                    </td>
                    <td>{routeFor(record)}</td>
                    <td>
                      <div className={styles.tagRow}>
                        {record.smartTags.map((tag) => (
                          <span key={tag} className={styles.tagChip}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className={styles.placementRow}>
                        {record.allowedPlacements.map((p) => (
                          <span key={p} className={styles.placementBadge}>
                            {p}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <span className={styles.statusBadge}>{record.sourceKind}</span>
                      {record.sourceLocations.map((loc, index) => (
                        <span
                          key={`${loc.filePath}-${index}`}
                          className={styles.sourcePath}
                        >
                          {loc.filePath}
                        </span>
                      ))}
                    </td>
                    <td>
                      <div className={gridStyles.rowActions}>
                        <button
                          type="button"
                          className={gridStyles.buttonGhost}
                          onClick={() => setEditing(record)}
                          {...{ 'data-testid': `walkthrough-anchor-edit-${record.id}` }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={gridStyles.buttonGhost}
                          onClick={() => setDeleting(record)}
                          {...{ 'data-testid': `walkthrough-anchor-delete-${record.id}` }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {syncOpen && (
        // data-testid-exempt — modal root sets walkthrough-anchor-sync-modal
        <WalkthroughAnchorSyncReviewModal
          candidates={reviewCandidates}
          enrichmentStatus={enrichmentStatus}
          enrichmentMessage={enrichmentMessage}
          batchSize={smartTaggingBatchSize}
          onBatchSizeChange={setSmartTaggingBatchSize}
          onSkipWaitingForAi={() => {
            smartTaggingAbortRef.current?.abort();
            setEnrichmentStatus('failed');
            setEnrichmentMessage(
              'Stopped waiting for AI. You can edit and Save now, or use Tag next AI batch to retry.',
            );
          }}
          onRunNextAiBatch={(batchSize) => handleRefineUncertain(batchSize)}
          nextAiBatchPending={enrichmentStatus === 'running'}
          onClose={() => {
            setSyncOpen(false);
            setLiveSyncCandidates([]);
            setEnrichmentStatus('idle');
            setEnrichmentMessage(null);
            smartTaggingAbortRef.current?.abort();
          }}
          onSave={handleSyncSave}
        />
      )}
      {addOpen && (
        // data-testid-exempt — modal root sets walkthrough-anchor-add-modal
        <AddAnchorModal onClose={() => setAddOpen(false)} />
      )}
      {editing && (
        // data-testid-exempt — modal root sets walkthrough-anchor-edit-modal
        <EditAnchorModal
          record={editing}
          availableOpeners={availableOpeners}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        // data-testid-exempt — modal root sets walkthrough-anchor-delete-modal
        <DeleteAnchorModal record={deleting} onClose={() => setDeleting(null)} />
      )}
    </section>
  );
};
