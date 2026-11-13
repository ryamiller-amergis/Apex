import React, { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ROADMAP_CHANGE_REASONS,
  ROADMAP_EFFORT_SIZES,
  ROADMAP_HORIZONS,
  type RoadmapChangeEventDto,
  type RoadmapConfidence,
  type RoadmapEffortSize,
  type RoadmapHorizon,
  type RoadmapPromoteTarget,
  type UpdateRoadmapAdhocIdeaInput,
  type UpsertRoadmapOverlayInput,
} from '../../shared/types/roadmap';
import type { WorkItem } from '../types/workitem';
import {
  formatShortDate,
  getOriginLabel,
  getScheduleSourceLabel,
  shiftIsoDate,
  type RoadmapWorkbenchItem,
} from '../utils/roadmapUtils';
import styles from './RoadmapView.module.css';

const inspectorSchema = z
  .object({
    title: z.string(),
    ownerLabel: z.string(),
    horizon: z.enum(ROADMAP_HORIZONS),
    confidence: z.enum(['unset', 'high', 'medium', 'low']),
    effortSize: z.enum(ROADMAP_EFFORT_SIZES),
    releaseLabel: z.string(),
    plannedStartDate: z.string(),
    plannedTargetDate: z.string(),
    resetBaseline: z.boolean(),
    reason: z.string().min(1, 'Select a reason'),
    note: z.string(),
    notes: z.string(),
  })
  .refine(
    (values) =>
      !values.plannedStartDate ||
      !values.plannedTargetDate ||
      values.plannedStartDate <= values.plannedTargetDate,
    {
      message: 'Planned start cannot be after target date',
      path: ['plannedTargetDate'],
    },
  );

type InspectorFormValues = z.infer<typeof inspectorSchema>;

export interface RoadmapInspectorPanelProps {
  item: RoadmapWorkbenchItem;
  events: RoadmapChangeEventDto[];
  isSaving: boolean;
  isPromoting: boolean;
  usesBoardWorkItems: boolean;
  errorMessage?: string | null;
  onClose: () => void;
  onSaveOverlay: (
    workItemId: number,
    payload: UpsertRoadmapOverlayInput,
  ) => Promise<void>;
  onSaveIdea: (
    ideaId: string,
    payload: UpdateRoadmapAdhocIdeaInput,
  ) => Promise<void>;
  onPromoteIdea: (ideaId: string, target: RoadmapPromoteTarget) => Promise<void>;
  onArchiveIdea: (ideaId: string) => Promise<void>;
  onOpenWorkItemDetails?: (workItem: WorkItem) => void;
}

export const RoadmapInspectorPanel: React.FC<RoadmapInspectorPanelProps> = ({
  item,
  events,
  isSaving,
  isPromoting,
  usesBoardWorkItems,
  errorMessage = null,
  onClose,
  onSaveOverlay,
  onSaveIdea,
  onPromoteIdea,
  onArchiveIdea,
  onOpenWorkItemDetails,
}) => {
  const itemEvents = useMemo(() => {
    return events
      .filter((ev) => {
        if (item.kind === 'work-item' && item.workItemId !== undefined) {
          return ev.workItemId === item.workItemId;
        }
        if (item.kind === 'adhoc-idea' && item.ideaId) {
          return ev.adhocIdeaId === item.ideaId;
        }
        return false;
      })
      .slice(0, 8);
  }, [events, item.ideaId, item.kind, item.workItemId]);

  const defaultReason = item.baselineTargetDate
    ? 'Scope Expansion'
    : 'Initial Baseline';

  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<InspectorFormValues>({
    resolver: zodResolver(inspectorSchema),
    defaultValues: {
      title: item.title,
      ownerLabel: item.idea?.ownerLabel ?? '',
      horizon: item.horizon,
      confidence: item.confidence ?? 'unset',
      effortSize: item.effortSize ?? 'M',
      releaseLabel: item.releaseLabel ?? '',
      plannedStartDate:
        item.kind === 'adhoc-idea'
          ? (item.idea?.plannedStartDate ?? '')
          : (item.overlay?.plannedStartDate ?? ''),
      plannedTargetDate:
        item.kind === 'adhoc-idea'
          ? (item.idea?.plannedTargetDate ?? '')
          : (item.overlay?.plannedTargetDate ?? item.effectiveTargetDate ?? ''),
      resetBaseline: false,
      reason: defaultReason,
      note: '',
      notes: item.notes ?? '',
    },
  });

  const handleQuickShift = (delta: { days?: number; months?: number }) => {
    const currentTarget =
      getValues('plannedTargetDate') || item.effectiveTargetDate;
    const shifted = shiftIsoDate(currentTarget, delta);
    setValue('plannedTargetDate', shifted, {
      shouldDirty: true,
      shouldValidate: true,
    });
    const currentStart = getValues('plannedStartDate');
    if (currentStart && currentStart > shifted) {
      setValue('plannedStartDate', shifted, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  };

  const onSubmit = async (values: InspectorFormValues) => {
    const resolvedConfidence: RoadmapConfidence | null =
      values.confidence === 'unset' ? null : values.confidence;

    if (item.kind === 'work-item' && item.workItemId !== undefined) {
      await onSaveOverlay(item.workItemId, {
        workItemType: item.workItemType,
        horizon: values.horizon as RoadmapHorizon,
        plannedStartDate: values.plannedStartDate || null,
        plannedTargetDate: values.plannedTargetDate || null,
        resetBaseline: values.resetBaseline,
        confidence: resolvedConfidence,
        notes: values.notes.trim() || null,
        itemTitle: item.title,
        itemOrigin: item.origin === 'board' ? 'board' : 'ado',
        reason: values.reason,
        note: values.note.trim() || null,
      });
      setValue('note', '');
      setValue('resetBaseline', false);
      return;
    }

    if (item.kind === 'adhoc-idea' && item.ideaId) {
      const safeTitle = values.title.trim() || item.title;
      await onSaveIdea(item.ideaId, {
        title: safeTitle,
        ownerLabel: values.ownerLabel.trim() || null,
        horizon: values.horizon as RoadmapHorizon,
        effortSize: values.effortSize as RoadmapEffortSize,
        confidence: resolvedConfidence ?? 'low',
        releaseLabel: values.releaseLabel.trim() || null,
        plannedStartDate: values.plannedStartDate || null,
        plannedTargetDate: values.plannedTargetDate || null,
        resetBaseline: values.resetBaseline,
        notes: values.notes.trim() || null,
        reason: values.reason,
        note: values.note.trim() || null,
      });
      setValue('note', '');
      setValue('resetBaseline', false);
    }
  };

  return (
    <aside
      className={styles.inspectorPanel}
      aria-label="Roadmap Inspector"
      data-testid="roadmap-inspector"
    >
      <div className={styles.inspectorHeader}>
        <div>
          <div className={styles.badgeRow}>
            <span
              className={`${styles.originBadge} ${
                item.origin === 'adhoc' ? styles.originAdhoc : ''
              }`}
            >
              {getOriginLabel(item.origin)}
              {item.workItemId ? ` #${item.workItemId}` : ''}
            </span>
            <span className={styles.sourcePill}>
              {getScheduleSourceLabel(item.scheduleSource)}
            </span>
            {item.slipDays !== null && item.slipDays > 0 && (
              <span className={`${styles.slipBadge} ${styles.slipLate}`}>
                +{item.slipDays}d slip
              </span>
            )}
          </div>
          <h3 className={styles.inspectorTitle}>{item.title}</h3>
        </div>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close inspector"
          data-testid="roadmap-inspector-close-btn"
        >
          ✕
        </button>
      </div>

      {errorMessage && (
        <div className={styles.bannerError} role="alert">
          {errorMessage}
        </div>
      )}

      {item.kind === 'work-item' && item.workItem && onOpenWorkItemDetails && (
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => onOpenWorkItemDetails(item.workItem!)}
          data-testid="roadmap-inspector-open-details"
        >
          Open Full Work Item Details
        </button>
      )}

      {item.kind === 'adhoc-idea' && item.ideaId && (
        <div className={styles.promotionBox}>
          <div className={styles.cardMetaRow}>
            <strong>Idea Lifecycle</strong>
            {item.promotedFeatureRequestId && (
              <span className={styles.promotedBadge}>
                Promoted · Feature Request
              </span>
            )}
            {item.promotedAdoWorkItemId && (
              <span className={styles.promotedBadge}>
                Promoted · Epic #{item.promotedAdoWorkItemId}
              </span>
            )}
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={isPromoting || Boolean(item.promotedFeatureRequestId)}
              onClick={() => onPromoteIdea(item.ideaId!, 'feature-request')}
              data-testid="roadmap-promote-idea-btn"
            >
              {item.promotedFeatureRequestId
                ? 'Promoted to Feature Request'
                : isPromoting
                  ? 'Promoting…'
                  : 'Promote to Feature Request'}
            </button>
            {!usesBoardWorkItems && !item.promotedAdoWorkItemId && (
              <button
                type="button"
                className={styles.secondaryBtn}
                disabled={isPromoting}
                onClick={() => onPromoteIdea(item.ideaId!, 'ado-epic')}
                data-testid="roadmap-promote-ado-btn"
              >
                Promote to ADO Epic
              </button>
            )}
            <button
              type="button"
              className={styles.dangerBtn}
              disabled={isSaving || isPromoting}
              onClick={() => onArchiveIdea(item.ideaId!)}
              data-testid="roadmap-archive-idea-btn"
            >
              Archive
            </button>
          </div>
        </div>
      )}

      <form
        className={styles.inspectorForm}
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        data-testid="roadmap-inspector-form"
      >
        {item.kind === 'adhoc-idea' && (
          <>
            <div className={styles.formField}>
              <label
                htmlFor="inspector-idea-title"
                className={styles.fieldLabel}
              >
                Idea Title
              </label>
              <input
                id="inspector-idea-title"
                type="text"
                className={styles.textInput}
                data-testid="roadmap-inspector-idea-title"
                {...register('title')}
              />
            </div>

            <div className={styles.fieldRow2}>
              <div className={styles.formField}>
                <label
                  htmlFor="inspector-idea-owner"
                  className={styles.fieldLabel}
                >
                  Owner
                </label>
                <input
                  id="inspector-idea-owner"
                  type="text"
                  className={styles.textInput}
                  data-testid="roadmap-inspector-idea-owner"
                  {...register('ownerLabel')}
                />
              </div>

              <div className={styles.formField}>
                <label
                  htmlFor="inspector-idea-effort"
                  className={styles.fieldLabel}
                >
                  Effort Size
                </label>
                <select
                  id="inspector-idea-effort"
                  className={styles.selectInput}
                  data-testid="roadmap-inspector-idea-effort"
                  {...register('effortSize')}
                >
                  <option value="S">S</option>
                  <option value="M">M</option>
                  <option value="L">L</option>
                  <option value="XL">XL</option>
                </select>
              </div>
            </div>
          </>
        )}

        <div className={styles.fieldRow2}>
          <div className={styles.formField}>
            <label htmlFor="inspector-horizon" className={styles.fieldLabel}>
              Horizon
            </label>
            <select
              id="inspector-horizon"
              className={styles.selectInput}
              data-testid="roadmap-inspector-horizon"
              {...register('horizon')}
            >
              <option value="now">Now</option>
              <option value="next">Next</option>
              <option value="later">Later</option>
              <option value="unplanned">Unplanned</option>
            </select>
          </div>

          <div className={styles.formField}>
            <label htmlFor="inspector-confidence" className={styles.fieldLabel}>
              Confidence
            </label>
            <select
              id="inspector-confidence"
              className={styles.selectInput}
              data-testid="roadmap-inspector-confidence"
              {...register('confidence')}
            >
              {item.kind === 'work-item' && (
                <option value="unset">Not set</option>
              )}
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>

        <div className={styles.fieldRow2}>
          <div className={styles.formField}>
            <label htmlFor="inspector-start-date" className={styles.fieldLabel}>
              Planned Start Date
            </label>
            <input
              id="inspector-start-date"
              type="date"
              className={styles.textInput}
              data-testid="roadmap-inspector-start-date"
              {...register('plannedStartDate')}
            />
          </div>

          <div className={styles.formField}>
            <label
              htmlFor="inspector-target-date"
              className={styles.fieldLabel}
            >
              Planned Target Date
            </label>
            <input
              id="inspector-target-date"
              type="date"
              className={styles.textInput}
              data-testid="roadmap-inspector-target-date"
              {...register('plannedTargetDate')}
            />
            {errors.plannedTargetDate && (
              <p className={styles.fieldError}>
                {errors.plannedTargetDate.message}
              </p>
            )}
          </div>
        </div>

        <div className={styles.quickShiftBar}>
          <span className={styles.fieldLabel}>Quick Shift Target:</span>
          <div className={styles.quickShiftButtons}>
            <button
              type="button"
              className={styles.miniActionBtn}
              onClick={() => handleQuickShift({ days: -7 })}
              data-testid="roadmap-shift-minus-1w"
            >
              -1w
            </button>
            <button
              type="button"
              className={styles.miniActionBtn}
              onClick={() => handleQuickShift({ days: 7 })}
              data-testid="roadmap-shift-plus-1w"
            >
              +1w
            </button>
            <button
              type="button"
              className={styles.miniActionBtn}
              onClick={() => handleQuickShift({ days: 14 })}
              data-testid="roadmap-shift-plus-2w"
            >
              +2w
            </button>
            <button
              type="button"
              className={styles.miniActionBtn}
              onClick={() => handleQuickShift({ months: 1 })}
              data-testid="roadmap-shift-plus-1m"
            >
              +1m
            </button>
          </div>
        </div>

        <div className={styles.baselineCallout}>
          <div>
            <strong>Baseline Target:</strong>{' '}
            {item.baselineTargetDate
              ? formatShortDate(item.baselineTargetDate)
              : 'Auto-locks on first planned target date'}
          </div>
          <label
            htmlFor="inspector-reset-baseline"
            className={styles.checkboxRow}
          >
            <input
              id="inspector-reset-baseline"
              type="checkbox"
              data-testid="roadmap-inspector-reset-baseline"
              {...register('resetBaseline')}
            />
            <span>Re-lock baseline to current target date</span>
          </label>
        </div>

        <div className={styles.formField}>
          <label htmlFor="inspector-reason" className={styles.fieldLabel}>
            Change Reason (Audited)
          </label>
          <select
            id="inspector-reason"
            className={styles.selectInput}
            data-testid="roadmap-inspector-reason"
            {...register('reason')}
          >
            {ROADMAP_CHANGE_REASONS.map((reasonOption) => (
              <option key={reasonOption} value={reasonOption}>
                {reasonOption}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.formField}>
          <label htmlFor="inspector-note" className={styles.fieldLabel}>
            Audit Note (Why this changed)
          </label>
          <input
            id="inspector-note"
            type="text"
            className={styles.textInput}
            placeholder="e.g., Added payer EDI validation scope"
            data-testid="roadmap-inspector-note"
            {...register('note')}
          />
        </div>

        <div className={styles.formField}>
          <label htmlFor="inspector-notes" className={styles.fieldLabel}>
            Planning Notes
          </label>
          <textarea
            id="inspector-notes"
            rows={2}
            className={styles.textareaInput}
            placeholder="Persistent planning assumptions or dependencies..."
            data-testid="roadmap-inspector-notes"
            {...register('notes')}
          />
        </div>

        <button
          type="submit"
          className={styles.primaryBtn}
          disabled={isSaving}
          data-testid="roadmap-inspector-save"
        >
          {isSaving ? 'Saving…' : 'Save Changes'}
        </button>
      </form>

      <div className={styles.miniHistorySection}>
        <h4 className={styles.miniHistoryTitle}>
          Item History ({itemEvents.length})
        </h4>
        {itemEvents.length === 0 ? (
          <p className={styles.infoCardText}>
            No audited horizon or target-date changes recorded yet.
          </p>
        ) : (
          <ul className={styles.miniHistoryList}>
            {itemEvents.map((ev) => (
              <li key={ev.id} className={styles.miniHistoryItem}>
                <div className={styles.cardMetaRow}>
                  <strong>{ev.reason}</strong>
                  <span>
                    {new Date(ev.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
                <div>
                  {ev.eventKind === 'horizon_changed' &&
                    `Horizon: ${ev.fromHorizon ?? 'auto'} → ${ev.toHorizon ?? 'auto'}`}
                  {ev.eventKind === 'baseline_locked' &&
                    `Baseline locked: ${formatShortDate(ev.newTargetDate)}`}
                  {ev.eventKind === 'date_changed' &&
                    `Target: ${formatShortDate(ev.oldTargetDate)} → ${formatShortDate(ev.newTargetDate)}${
                      ev.deltaDays !== null
                        ? ` (${ev.deltaDays > 0 ? `+${ev.deltaDays}d` : `${ev.deltaDays}d`})`
                        : ''
                    }`}
                  {ev.eventKind === 'idea_created' &&
                    `Idea created in ${ev.toHorizon ?? 'later'}`}
                  {ev.eventKind === 'idea_promoted' &&
                    (ev.note ?? 'Idea promoted')}
                </div>
                {ev.note && ev.eventKind !== 'idea_promoted' && (
                  <div className={styles.kpiSub}>{ev.note}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
};
