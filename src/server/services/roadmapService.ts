import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  roadmapAdhocIdeas,
  roadmapChangeEvents,
  roadmapPlanOverlays,
  roadmapProjectSettings,
} from '../db/schema';
import {
  ROADMAP_CONFIDENCE_LEVELS,
  ROADMAP_EFFORT_SIZES,
  ROADMAP_HORIZONS,
  type CreateRoadmapAdhocIdeaInput,
  type MutateRoadmapAdhocIdeaResponse,
  type PromoteRoadmapAdhocIdeaInput,
  type PromoteRoadmapAdhocIdeaResponse,
  type RoadmapAdhocIdeaDto,
  type RoadmapChangeEventDto,
  type RoadmapChangeEventKind,
  type RoadmapConfidence,
  type RoadmapEffortSize,
  type RoadmapHorizon,
  type RoadmapItemOrigin,
  type RoadmapPlanOverlayDto,
  type RoadmapProjectSettingsDto,
  type RoadmapWorkspaceResponse,
  type UpdateRoadmapAdhocIdeaInput,
  type UpdateRoadmapSettingsInput,
  type UpsertRoadmapOverlayInput,
  type UpsertRoadmapOverlayResponse,
} from '../../shared/types/roadmap';
import * as featureRequestService from './featureRequestService';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHANGE_EVENTS = 200;

export interface RoadmapActor {
  actorId: string;
  actorName: string;
}

export class RoadmapServiceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'RoadmapServiceError';
    this.status = status;
  }
}

function requireProject(project: string): string {
  const trimmed = project?.trim();
  if (!trimmed) {
    throw new RoadmapServiceError('project is required', 400);
  }
  return trimmed;
}

function validateUuid(value: string, fieldName: string): string {
  const trimmed = value?.trim();
  if (!trimmed || !UUID_PATTERN.test(trimmed)) {
    throw new RoadmapServiceError(`${fieldName} must be a valid UUID`, 400);
  }
  return trimmed;
}

function normalizeNullableText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalDate(
  value: string | null | undefined,
  fieldName: string,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  const trimmed = value.trim();
  if (!DATE_PATTERN.test(trimmed)) {
    throw new RoadmapServiceError(
      `${fieldName} must be formatted as YYYY-MM-DD`,
      400,
    );
  }
  const [year, month, day] = trimmed.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new RoadmapServiceError(`${fieldName} is not a valid calendar date`, 400);
  }
  return trimmed;
}

function assertDateRangeOrder(
  startDate: string | null,
  targetDate: string | null,
): void {
  if (startDate && targetDate && startDate > targetDate) {
    throw new RoadmapServiceError(
      'plannedStartDate cannot be after plannedTargetDate',
      400,
    );
  }
}

function validateHorizon(
  horizon: unknown,
  allowNull: boolean,
): RoadmapHorizon | null {
  if (horizon === null && allowNull) return null;
  if (
    typeof horizon === 'string' &&
    (ROADMAP_HORIZONS as readonly string[]).includes(horizon)
  ) {
    return horizon as RoadmapHorizon;
  }
  throw new RoadmapServiceError(
    `horizon must be one of ${ROADMAP_HORIZONS.join(', ')}${allowNull ? ' or null' : ''}`,
    400,
  );
}

function validateConfidence(
  confidence: unknown,
  allowNull: boolean,
): RoadmapConfidence | null {
  if (confidence === null && allowNull) return null;
  if (
    typeof confidence === 'string' &&
    (ROADMAP_CONFIDENCE_LEVELS as readonly string[]).includes(confidence)
  ) {
    return confidence as RoadmapConfidence;
  }
  throw new RoadmapServiceError(
    `confidence must be one of ${ROADMAP_CONFIDENCE_LEVELS.join(', ')}${allowNull ? ' or null' : ''}`,
    400,
  );
}

function validateEffortSize(effortSize: unknown): RoadmapEffortSize {
  if (
    typeof effortSize === 'string' &&
    (ROADMAP_EFFORT_SIZES as readonly string[]).includes(effortSize)
  ) {
    return effortSize as RoadmapEffortSize;
  }
  throw new RoadmapServiceError(
    `effortSize must be one of ${ROADMAP_EFFORT_SIZES.join(', ')}`,
    400,
  );
}

export function calculateDateDeltaDays(
  oldDate: string | null | undefined,
  newDate: string | null | undefined,
): number | null {
  if (!oldDate || !newDate) return null;
  if (!DATE_PATTERN.test(oldDate) || !DATE_PATTERN.test(newDate)) return null;
  const [oy, om, od] = oldDate.split('-').map(Number);
  const [ny, nm, nd] = newDate.split('-').map(Number);
  const oldUtc = Date.UTC(oy, om - 1, od);
  const newUtc = Date.UTC(ny, nm - 1, nd);
  return Math.round((newUtc - oldUtc) / 86_400_000);
}

type SettingsRow = typeof roadmapProjectSettings.$inferSelect;
type OverlayRow = typeof roadmapPlanOverlays.$inferSelect;
type IdeaRow = typeof roadmapAdhocIdeas.$inferSelect;
type EventRow = typeof roadmapChangeEvents.$inferSelect;

function toSettingsDto(row: SettingsRow): RoadmapProjectSettingsDto {
  return {
    project: row.project,
    syncDatesToAdo: row.syncDatesToAdo,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

function toOverlayDto(row: OverlayRow): RoadmapPlanOverlayDto {
  return {
    id: row.id,
    project: row.project,
    workItemId: row.workItemId,
    workItemType: row.workItemType,
    horizon: row.horizon ?? null,
    plannedStartDate: row.plannedStartDate ?? null,
    plannedTargetDate: row.plannedTargetDate ?? null,
    baselineTargetDate: row.baselineTargetDate ?? null,
    confidence: row.confidence ?? null,
    notes: row.notes ?? null,
    sortOrder: row.sortOrder,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIdeaDto(row: IdeaRow): RoadmapAdhocIdeaDto {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    ownerLabel: row.ownerLabel ?? null,
    horizon: row.horizon,
    effortSize: row.effortSize,
    confidence: row.confidence,
    releaseLabel: row.releaseLabel ?? null,
    notes: row.notes ?? null,
    plannedStartDate: row.plannedStartDate ?? null,
    plannedTargetDate: row.plannedTargetDate ?? null,
    baselineTargetDate: row.baselineTargetDate ?? null,
    promotedFeatureRequestId: row.promotedFeatureRequestId ?? null,
    promotedAdoWorkItemId: row.promotedAdoWorkItemId ?? null,
    promotedAt: row.promotedAt ?? null,
    archived: row.archived,
    sortOrder: row.sortOrder,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEventDto(row: EventRow): RoadmapChangeEventDto {
  return {
    id: row.id,
    project: row.project,
    workItemId: row.workItemId ?? null,
    adhocIdeaId: row.adhocIdeaId ?? null,
    itemTitle: row.itemTitle,
    itemOrigin: row.itemOrigin,
    eventKind: row.eventKind,
    fromHorizon: row.fromHorizon ?? null,
    toHorizon: row.toHorizon ?? null,
    oldTargetDate: row.oldTargetDate ?? null,
    newTargetDate: row.newTargetDate ?? null,
    deltaDays: row.deltaDays ?? null,
    reason: row.reason,
    note: row.note ?? null,
    syncedToAdo: row.syncedToAdo,
    actorId: row.actorId,
    actorName: row.actorName,
    createdAt: row.createdAt,
  };
}

export async function getRoadmapSettings(
  project: string,
): Promise<RoadmapProjectSettingsDto> {
  const normalizedProject = requireProject(project);
  const row = await db.query.roadmapProjectSettings.findFirst({
    where: eq(roadmapProjectSettings.project, normalizedProject),
  });
  if (!row) {
    return {
      project: normalizedProject,
      syncDatesToAdo: false,
      updatedBy: 'system',
      updatedAt: new Date(0).toISOString(),
    };
  }
  return toSettingsDto(row);
}

export async function getRoadmapWorkspace(
  project: string,
): Promise<RoadmapWorkspaceResponse> {
  const normalizedProject = requireProject(project);

  const [settings, overlayRows, ideaRows, eventRows] = await Promise.all([
    getRoadmapSettings(normalizedProject),
    db
      .select()
      .from(roadmapPlanOverlays)
      .where(eq(roadmapPlanOverlays.project, normalizedProject))
      .orderBy(
        asc(roadmapPlanOverlays.sortOrder),
        asc(roadmapPlanOverlays.workItemId),
      ),
    db
      .select()
      .from(roadmapAdhocIdeas)
      .where(
        and(
          eq(roadmapAdhocIdeas.project, normalizedProject),
          eq(roadmapAdhocIdeas.archived, false),
        ),
      )
      .orderBy(
        asc(roadmapAdhocIdeas.sortOrder),
        asc(roadmapAdhocIdeas.createdAt),
      ),
    db
      .select()
      .from(roadmapChangeEvents)
      .where(eq(roadmapChangeEvents.project, normalizedProject))
      .orderBy(desc(roadmapChangeEvents.createdAt))
      .limit(MAX_CHANGE_EVENTS),
  ]);

  return {
    settings,
    overlays: overlayRows.map(toOverlayDto),
    ideas: ideaRows.map(toIdeaDto),
    events: eventRows.map(toEventDto),
  };
}

export async function updateRoadmapSettings(
  project: string,
  input: UpdateRoadmapSettingsInput,
  actorId: string,
): Promise<RoadmapProjectSettingsDto> {
  const normalizedProject = requireProject(project);
  if (typeof input?.syncDatesToAdo !== 'boolean') {
    throw new RoadmapServiceError('syncDatesToAdo must be a boolean', 400);
  }
  const nowIso = new Date().toISOString();
  const [row] = await db
    .insert(roadmapProjectSettings)
    .values({
      project: normalizedProject,
      syncDatesToAdo: input.syncDatesToAdo,
      updatedBy: actorId,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: roadmapProjectSettings.project,
      set: {
        syncDatesToAdo: input.syncDatesToAdo,
        updatedBy: actorId,
        updatedAt: nowIso,
      },
    })
    .returning();

  return toSettingsDto(row);
}

interface PendingChangeEvent {
  eventKind: RoadmapChangeEventKind;
  fromHorizon?: RoadmapHorizon | null;
  toHorizon?: RoadmapHorizon | null;
  oldTargetDate?: string | null;
  newTargetDate?: string | null;
  deltaDays?: number | null;
  reason: string;
  note: string | null;
  syncedToAdo: boolean;
}

function buildScheduleChangeEvents(params: {
  prevHorizon: RoadmapHorizon | null;
  nextHorizon: RoadmapHorizon | null;
  horizonProvided: boolean;
  prevTarget: string | null;
  nextTarget: string | null;
  prevBaseline: string | null;
  nextBaseline: string | null;
  resetBaseline: boolean;
  reason?: string;
  note?: string | null;
  syncedToAdo: boolean;
}): PendingChangeEvent[] {
  const events: PendingChangeEvent[] = [];
  const cleanNote = normalizeNullableText(params.note);
  const customReason = params.reason?.trim() || '';

  if (params.horizonProvided && params.nextHorizon !== params.prevHorizon) {
    events.push({
      eventKind: 'horizon_changed',
      fromHorizon: params.prevHorizon,
      toHorizon: params.nextHorizon,
      reason: customReason || 'Horizon Re-prioritized',
      note: cleanNote,
      syncedToAdo: false,
    });
  }

  const firstTimeBaselineLocked =
    params.prevBaseline === null && params.nextBaseline !== null;
  const explicitBaselineReset =
    params.resetBaseline &&
    params.prevBaseline !== null &&
    params.nextBaseline !== null &&
    params.nextBaseline !== params.prevBaseline;

  if (firstTimeBaselineLocked) {
    events.push({
      eventKind: 'baseline_locked',
      oldTargetDate: null,
      newTargetDate: params.nextBaseline,
      deltaDays: 0,
      reason: customReason || 'Initial Baseline',
      note: cleanNote,
      syncedToAdo: params.syncedToAdo,
    });
  } else if (params.nextTarget !== params.prevTarget) {
    const referenceDate = params.prevTarget ?? params.prevBaseline;
    events.push({
      eventKind: 'date_changed',
      oldTargetDate: params.prevTarget,
      newTargetDate: params.nextTarget,
      deltaDays: calculateDateDeltaDays(referenceDate, params.nextTarget),
      reason: customReason || 'Estimate Refined',
      note: cleanNote,
      syncedToAdo: params.syncedToAdo,
    });
  }

  if (explicitBaselineReset) {
    events.push({
      eventKind: 'baseline_locked',
      oldTargetDate: params.prevBaseline,
      newTargetDate: params.nextBaseline,
      deltaDays: calculateDateDeltaDays(
        params.prevBaseline,
        params.nextBaseline,
      ),
      reason: customReason || 'Baseline Reset',
      note: cleanNote,
      syncedToAdo: params.syncedToAdo,
    });
  }

  return events;
}

export async function getExistingOverlay(
  project: string,
  workItemId: number,
): Promise<RoadmapPlanOverlayDto | null> {
  const normalizedProject = requireProject(project);
  const row = await db.query.roadmapPlanOverlays.findFirst({
    where: and(
      eq(roadmapPlanOverlays.project, normalizedProject),
      eq(roadmapPlanOverlays.workItemId, workItemId),
    ),
  });
  return row ? toOverlayDto(row) : null;
}

export interface AdoDateSyncCallbackInput {
  workItemId: number;
  targetDate: string | null;
  historyComment: string;
}

export async function upsertRoadmapOverlay(
  project: string,
  workItemId: number,
  input: UpsertRoadmapOverlayInput,
  actor: RoadmapActor,
  syncToAdo?: (payload: AdoDateSyncCallbackInput) => Promise<void>,
): Promise<UpsertRoadmapOverlayResponse> {
  const normalizedProject = requireProject(project);
  if (!Number.isInteger(workItemId) || workItemId <= 0) {
    throw new RoadmapServiceError('workItemId must be a positive integer', 400);
  }
  const itemTitle = input?.itemTitle?.trim();
  if (!itemTitle) {
    throw new RoadmapServiceError('itemTitle is required', 400);
  }
  const itemOrigin: RoadmapItemOrigin =
    input.itemOrigin === 'board' ? 'board' : 'ado';
  if (
    input.itemOrigin !== undefined &&
    input.itemOrigin !== 'ado' &&
    input.itemOrigin !== 'board'
  ) {
    throw new RoadmapServiceError('itemOrigin must be ado or board', 400);
  }

  const existing = await db.query.roadmapPlanOverlays.findFirst({
    where: and(
      eq(roadmapPlanOverlays.project, normalizedProject),
      eq(roadmapPlanOverlays.workItemId, workItemId),
    ),
  });

  const nextHorizon =
    input.horizon !== undefined
      ? validateHorizon(input.horizon, true)
      : (existing?.horizon ?? null);
  const nextPlannedStart =
    input.plannedStartDate !== undefined
      ? normalizeOptionalDate(input.plannedStartDate, 'plannedStartDate')
      : (existing?.plannedStartDate ?? null);
  const nextPlannedTarget =
    input.plannedTargetDate !== undefined
      ? normalizeOptionalDate(input.plannedTargetDate, 'plannedTargetDate')
      : (existing?.plannedTargetDate ?? null);
  assertDateRangeOrder(nextPlannedStart, nextPlannedTarget);

  const nextConfidence =
    input.confidence !== undefined
      ? validateConfidence(input.confidence, true)
      : (existing?.confidence ?? null);
  const nextNotes =
    input.notes !== undefined
      ? normalizeNullableText(input.notes)
      : (existing?.notes ?? null);
  const nextSortOrder =
    typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
      ? Math.trunc(input.sortOrder)
      : (existing?.sortOrder ?? 0);
  const workItemType =
    input.workItemType?.trim() || existing?.workItemType || 'Epic';

  const prevBaseline = existing?.baselineTargetDate ?? null;
  const prevTarget = existing?.plannedTargetDate ?? null;
  const prevHorizon = existing?.horizon ?? null;
  const resetBaseline = input.resetBaseline === true;

  let nextBaseline: string | null;
  if (resetBaseline) {
    nextBaseline = nextPlannedTarget;
  } else if (!prevBaseline && nextPlannedTarget) {
    nextBaseline = nextPlannedTarget;
  } else {
    nextBaseline = prevBaseline;
  }

  const settings = await getRoadmapSettings(normalizedProject);
  const targetChanged =
    input.plannedTargetDate !== undefined && nextPlannedTarget !== prevTarget;

  let syncedToAdo = false;
  if (
    settings.syncDatesToAdo &&
    targetChanged &&
    itemOrigin === 'ado' &&
    syncToAdo
  ) {
    const reasonLabel =
      input.reason?.trim() ||
      (!prevBaseline && nextPlannedTarget
        ? 'Initial Baseline'
        : 'Estimate Refined');
    const cleanNote = normalizeNullableText(input.note);
    const historyComment = cleanNote
      ? `Roadmap target date updated (${reasonLabel}): ${cleanNote}`
      : `Roadmap target date updated (${reasonLabel})`;
    await syncToAdo({
      workItemId,
      targetDate: nextPlannedTarget,
      historyComment,
    });
    syncedToAdo = true;
  }

  const pendingEvents = buildScheduleChangeEvents({
    prevHorizon,
    nextHorizon,
    horizonProvided: input.horizon !== undefined,
    prevTarget,
    nextTarget: nextPlannedTarget,
    prevBaseline,
    nextBaseline,
    resetBaseline,
    reason: input.reason,
    note: input.note,
    syncedToAdo,
  });

  const nowIso = new Date().toISOString();

  const { overlayRow, insertedEvents } = await db.transaction(async (tx) => {
    const [upserted] = await tx
      .insert(roadmapPlanOverlays)
      .values({
        project: normalizedProject,
        workItemId,
        workItemType,
        horizon: nextHorizon,
        plannedStartDate: nextPlannedStart,
        plannedTargetDate: nextPlannedTarget,
        baselineTargetDate: nextBaseline,
        confidence: nextConfidence,
        notes: nextNotes,
        sortOrder: nextSortOrder,
        updatedBy: actor.actorId,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: [roadmapPlanOverlays.project, roadmapPlanOverlays.workItemId],
        set: {
          workItemType,
          horizon: nextHorizon,
          plannedStartDate: nextPlannedStart,
          plannedTargetDate: nextPlannedTarget,
          baselineTargetDate: nextBaseline,
          confidence: nextConfidence,
          notes: nextNotes,
          sortOrder: nextSortOrder,
          updatedBy: actor.actorId,
          updatedAt: nowIso,
        },
      })
      .returning();

    const createdEvents: EventRow[] = [];
    for (const ev of pendingEvents) {
      const [inserted] = await tx
        .insert(roadmapChangeEvents)
        .values({
          project: normalizedProject,
          workItemId,
          adhocIdeaId: null,
          itemTitle,
          itemOrigin,
          eventKind: ev.eventKind,
          fromHorizon: ev.fromHorizon ?? null,
          toHorizon: ev.toHorizon ?? null,
          oldTargetDate: ev.oldTargetDate ?? null,
          newTargetDate: ev.newTargetDate ?? null,
          deltaDays: ev.deltaDays ?? null,
          reason: ev.reason,
          note: ev.note,
          syncedToAdo: ev.syncedToAdo,
          actorId: actor.actorId,
          actorName: actor.actorName,
        })
        .returning();
      createdEvents.push(inserted);
    }

    return { overlayRow: upserted, insertedEvents: createdEvents };
  });

  return {
    overlay: toOverlayDto(overlayRow),
    events: insertedEvents.map(toEventDto),
    syncedToAdo,
  };
}

export async function createRoadmapIdea(
  project: string,
  input: CreateRoadmapAdhocIdeaInput,
  actor: RoadmapActor,
): Promise<MutateRoadmapAdhocIdeaResponse> {
  const normalizedProject = requireProject(project);
  const title = input?.title?.trim();
  if (!title) {
    throw new RoadmapServiceError('title is required', 400);
  }

  const horizon =
    input.horizon !== undefined
      ? (validateHorizon(input.horizon, false) as RoadmapHorizon)
      : 'later';
  const effortSize =
    input.effortSize !== undefined
      ? validateEffortSize(input.effortSize)
      : 'M';
  const confidence =
    input.confidence !== undefined
      ? (validateConfidence(input.confidence, false) as RoadmapConfidence)
      : 'low';
  const plannedStartDate = normalizeOptionalDate(
    input.plannedStartDate,
    'plannedStartDate',
  );
  const plannedTargetDate = normalizeOptionalDate(
    input.plannedTargetDate,
    'plannedTargetDate',
  );
  assertDateRangeOrder(plannedStartDate, plannedTargetDate);

  const ownerLabel = normalizeNullableText(input.ownerLabel);
  const releaseLabel = normalizeNullableText(input.releaseLabel);
  const notes = normalizeNullableText(input.notes);
  const sortOrder =
    typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
      ? Math.trunc(input.sortOrder)
      : 0;
  const baselineTargetDate = plannedTargetDate;

  const { ideaRow, eventRow } = await db.transaction(async (tx) => {
    const [createdIdea] = await tx
      .insert(roadmapAdhocIdeas)
      .values({
        project: normalizedProject,
        title,
        ownerLabel,
        horizon,
        effortSize,
        confidence,
        releaseLabel,
        notes,
        plannedStartDate,
        plannedTargetDate,
        baselineTargetDate,
        sortOrder,
        createdBy: actor.actorId,
        updatedBy: actor.actorId,
      })
      .returning();

    const [createdEvent] = await tx
      .insert(roadmapChangeEvents)
      .values({
        project: normalizedProject,
        workItemId: null,
        adhocIdeaId: createdIdea.id,
        itemTitle: title,
        itemOrigin: 'adhoc',
        eventKind: 'idea_created',
        fromHorizon: null,
        toHorizon: horizon,
        oldTargetDate: null,
        newTargetDate: plannedTargetDate,
        deltaDays: plannedTargetDate ? 0 : null,
        reason: plannedTargetDate ? 'Initial Baseline' : 'Horizon Re-prioritized',
        note: notes,
        syncedToAdo: false,
        actorId: actor.actorId,
        actorName: actor.actorName,
      })
      .returning();

    return { ideaRow: createdIdea, eventRow: createdEvent };
  });

  return {
    idea: toIdeaDto(ideaRow),
    events: [toEventDto(eventRow)],
  };
}

export async function updateRoadmapIdea(
  project: string,
  ideaId: string,
  input: UpdateRoadmapAdhocIdeaInput,
  actor: RoadmapActor,
): Promise<MutateRoadmapAdhocIdeaResponse> {
  const normalizedProject = requireProject(project);
  const validIdeaId = validateUuid(ideaId, 'ideaId');

  const existing = await db.query.roadmapAdhocIdeas.findFirst({
    where: and(
      eq(roadmapAdhocIdeas.id, validIdeaId),
      eq(roadmapAdhocIdeas.project, normalizedProject),
      eq(roadmapAdhocIdeas.archived, false),
    ),
  });
  if (!existing) {
    throw new RoadmapServiceError('Roadmap ad-hoc idea not found', 404);
  }

  let nextTitle = existing.title;
  if (input.title !== undefined) {
    const trimmed = input.title.trim();
    if (!trimmed) {
      throw new RoadmapServiceError('title cannot be empty', 400);
    }
    nextTitle = trimmed;
  }

  const nextOwnerLabel =
    input.ownerLabel !== undefined
      ? normalizeNullableText(input.ownerLabel)
      : existing.ownerLabel;
  const nextHorizon =
    input.horizon !== undefined
      ? (validateHorizon(input.horizon, false) as RoadmapHorizon)
      : existing.horizon;
  const nextEffortSize =
    input.effortSize !== undefined
      ? validateEffortSize(input.effortSize)
      : existing.effortSize;
  const nextConfidence =
    input.confidence !== undefined
      ? (validateConfidence(input.confidence, false) as RoadmapConfidence)
      : existing.confidence;
  const nextReleaseLabel =
    input.releaseLabel !== undefined
      ? normalizeNullableText(input.releaseLabel)
      : existing.releaseLabel;
  const nextNotes =
    input.notes !== undefined
      ? normalizeNullableText(input.notes)
      : existing.notes;
  const nextPlannedStart =
    input.plannedStartDate !== undefined
      ? normalizeOptionalDate(input.plannedStartDate, 'plannedStartDate')
      : existing.plannedStartDate;
  const nextPlannedTarget =
    input.plannedTargetDate !== undefined
      ? normalizeOptionalDate(input.plannedTargetDate, 'plannedTargetDate')
      : existing.plannedTargetDate;
  assertDateRangeOrder(nextPlannedStart, nextPlannedTarget);

  const nextSortOrder =
    typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
      ? Math.trunc(input.sortOrder)
      : existing.sortOrder;

  const prevBaseline = existing.baselineTargetDate ?? null;
  const prevTarget = existing.plannedTargetDate ?? null;
  const prevHorizon = existing.horizon;
  const resetBaseline = input.resetBaseline === true;

  let nextBaseline: string | null;
  if (resetBaseline) {
    nextBaseline = nextPlannedTarget;
  } else if (!prevBaseline && nextPlannedTarget) {
    nextBaseline = nextPlannedTarget;
  } else {
    nextBaseline = prevBaseline;
  }

  const pendingEvents = buildScheduleChangeEvents({
    prevHorizon,
    nextHorizon,
    horizonProvided: input.horizon !== undefined,
    prevTarget,
    nextTarget: nextPlannedTarget,
    prevBaseline,
    nextBaseline,
    resetBaseline,
    reason: input.reason,
    note: input.note,
    syncedToAdo: false,
  });

  const nowIso = new Date().toISOString();

  const { updatedRow, insertedEvents } = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(roadmapAdhocIdeas)
      .set({
        title: nextTitle,
        ownerLabel: nextOwnerLabel,
        horizon: nextHorizon,
        effortSize: nextEffortSize,
        confidence: nextConfidence,
        releaseLabel: nextReleaseLabel,
        notes: nextNotes,
        plannedStartDate: nextPlannedStart,
        plannedTargetDate: nextPlannedTarget,
        baselineTargetDate: nextBaseline,
        sortOrder: nextSortOrder,
        updatedBy: actor.actorId,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(roadmapAdhocIdeas.id, validIdeaId),
          eq(roadmapAdhocIdeas.project, normalizedProject),
        ),
      )
      .returning();

    const createdEvents: EventRow[] = [];
    for (const ev of pendingEvents) {
      const [inserted] = await tx
        .insert(roadmapChangeEvents)
        .values({
          project: normalizedProject,
          workItemId: existing.promotedAdoWorkItemId ?? null,
          adhocIdeaId: validIdeaId,
          itemTitle: nextTitle,
          itemOrigin: 'adhoc',
          eventKind: ev.eventKind,
          fromHorizon: ev.fromHorizon ?? null,
          toHorizon: ev.toHorizon ?? null,
          oldTargetDate: ev.oldTargetDate ?? null,
          newTargetDate: ev.newTargetDate ?? null,
          deltaDays: ev.deltaDays ?? null,
          reason: ev.reason,
          note: ev.note,
          syncedToAdo: false,
          actorId: actor.actorId,
          actorName: actor.actorName,
        })
        .returning();
      createdEvents.push(inserted);
    }

    return { updatedRow: updated, insertedEvents: createdEvents };
  });

  return {
    idea: toIdeaDto(updatedRow),
    events: insertedEvents.map(toEventDto),
  };
}

export async function deleteRoadmapIdea(
  project: string,
  ideaId: string,
  actorId: string,
): Promise<void> {
  const normalizedProject = requireProject(project);
  const validIdeaId = validateUuid(ideaId, 'ideaId');

  const existing = await db.query.roadmapAdhocIdeas.findFirst({
    where: and(
      eq(roadmapAdhocIdeas.id, validIdeaId),
      eq(roadmapAdhocIdeas.project, normalizedProject),
    ),
  });
  if (!existing) {
    throw new RoadmapServiceError('Roadmap ad-hoc idea not found', 404);
  }

  await db
    .update(roadmapAdhocIdeas)
    .set({
      archived: true,
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(roadmapAdhocIdeas.id, validIdeaId),
        eq(roadmapAdhocIdeas.project, normalizedProject),
      ),
    );
}

function buildPromotedIdeaDescription(idea: IdeaRow): string {
  const sections: string[] = [];
  if (idea.notes?.trim()) {
    sections.push(idea.notes.trim());
  } else {
    sections.push(`Promoted from Living Roadmap ad-hoc idea: ${idea.title}`);
  }

  const metaLines: string[] = [
    `- Horizon: ${idea.horizon.toUpperCase()}`,
    `- Effort Size: ${idea.effortSize}`,
    `- Confidence: ${idea.confidence}`,
  ];
  if (idea.ownerLabel) metaLines.push(`- Owner: ${idea.ownerLabel}`);
  if (idea.releaseLabel) metaLines.push(`- Release: ${idea.releaseLabel}`);
  if (idea.plannedStartDate) {
    metaLines.push(`- Planned Start Date: ${idea.plannedStartDate}`);
  }
  if (idea.plannedTargetDate) {
    metaLines.push(`- Planned Target Date: ${idea.plannedTargetDate}`);
  }
  sections.push(`Roadmap Planning Context:\n${metaLines.join('\n')}`);
  return sections.join('\n\n');
}

export async function promoteRoadmapIdea(
  project: string,
  ideaId: string,
  input: PromoteRoadmapAdhocIdeaInput,
  actor: RoadmapActor,
  createAdoEpic?: (spec: {
    title: string;
    description: string;
  }) => Promise<{ id: number; url: string }>,
): Promise<PromoteRoadmapAdhocIdeaResponse> {
  const normalizedProject = requireProject(project);
  const validIdeaId = validateUuid(ideaId, 'ideaId');

  if (
    input?.target !== 'feature-request' &&
    input?.target !== 'ado-epic'
  ) {
    throw new RoadmapServiceError(
      'target must be feature-request or ado-epic',
      400,
    );
  }

  const existing = await db.query.roadmapAdhocIdeas.findFirst({
    where: and(
      eq(roadmapAdhocIdeas.id, validIdeaId),
      eq(roadmapAdhocIdeas.project, normalizedProject),
      eq(roadmapAdhocIdeas.archived, false),
    ),
  });
  if (!existing) {
    throw new RoadmapServiceError('Roadmap ad-hoc idea not found', 404);
  }

  const description = buildPromotedIdeaDescription(existing);
  const nowIso = new Date().toISOString();

  if (input.target === 'feature-request') {
    if (existing.promotedFeatureRequestId) {
      throw new RoadmapServiceError(
        'Idea has already been promoted to a Feature Request',
        400,
      );
    }

    const createdRequest = await featureRequestService.createFeatureRequest(
      actor.actorId,
      normalizedProject,
      {
        type: 'feature',
        title: existing.title,
        request: description,
        advantage: existing.notes?.trim() || null,
      },
    );

    const { updatedIdea, promotedEvent } = await db.transaction(async (tx) => {
      const [ideaRow] = await tx
        .update(roadmapAdhocIdeas)
        .set({
          promotedFeatureRequestId: createdRequest.id,
          promotedAt: nowIso,
          updatedBy: actor.actorId,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(roadmapAdhocIdeas.id, validIdeaId),
            eq(roadmapAdhocIdeas.project, normalizedProject),
          ),
        )
        .returning();

      const [eventRow] = await tx
        .insert(roadmapChangeEvents)
        .values({
          project: normalizedProject,
          workItemId: existing.promotedAdoWorkItemId ?? null,
          adhocIdeaId: validIdeaId,
          itemTitle: existing.title,
          itemOrigin: 'adhoc',
          eventKind: 'idea_promoted',
          fromHorizon: existing.horizon,
          toHorizon: existing.horizon,
          oldTargetDate: existing.plannedTargetDate,
          newTargetDate: existing.plannedTargetDate,
          deltaDays: null,
          reason: 'Promoted Idea',
          note: `Promoted to Feature Request (${createdRequest.id})`,
          syncedToAdo: false,
          actorId: actor.actorId,
          actorName: actor.actorName,
        })
        .returning();

      return { updatedIdea: ideaRow, promotedEvent: eventRow };
    });

    return {
      idea: toIdeaDto(updatedIdea),
      event: toEventDto(promotedEvent),
      featureRequestId: createdRequest.id,
    };
  }

  if (existing.promotedAdoWorkItemId) {
    throw new RoadmapServiceError(
      'Idea has already been promoted to an Azure DevOps Epic',
      400,
    );
  }
  if (!createAdoEpic) {
    throw new RoadmapServiceError(
      'Azure DevOps Epic creation handler is unavailable',
      400,
    );
  }

  const createdEpic = await createAdoEpic({
    title: existing.title,
    description,
  });

  const { updatedIdea, overlayRow, promotedEvent } = await db.transaction(
    async (tx) => {
      const effectiveBaseline =
        existing.baselineTargetDate ?? existing.plannedTargetDate ?? null;

      const [upsertedOverlay] = await tx
        .insert(roadmapPlanOverlays)
        .values({
          project: normalizedProject,
          workItemId: createdEpic.id,
          workItemType: 'Epic',
          horizon: existing.horizon,
          plannedStartDate: existing.plannedStartDate,
          plannedTargetDate: existing.plannedTargetDate,
          baselineTargetDate: effectiveBaseline,
          confidence: existing.confidence,
          notes: existing.notes,
          sortOrder: existing.sortOrder,
          updatedBy: actor.actorId,
          updatedAt: nowIso,
        })
        .onConflictDoUpdate({
          target: [roadmapPlanOverlays.project, roadmapPlanOverlays.workItemId],
          set: {
            workItemType: 'Epic',
            horizon: existing.horizon,
            plannedStartDate: existing.plannedStartDate,
            plannedTargetDate: existing.plannedTargetDate,
            baselineTargetDate: effectiveBaseline,
            confidence: existing.confidence,
            notes: existing.notes,
            sortOrder: existing.sortOrder,
            updatedBy: actor.actorId,
            updatedAt: nowIso,
          },
        })
        .returning();

      await tx
        .update(roadmapChangeEvents)
        .set({ workItemId: createdEpic.id })
        .where(
          and(
            eq(roadmapChangeEvents.project, normalizedProject),
            eq(roadmapChangeEvents.adhocIdeaId, validIdeaId),
          ),
        );

      const [ideaRow] = await tx
        .update(roadmapAdhocIdeas)
        .set({
          promotedAdoWorkItemId: createdEpic.id,
          promotedAt: nowIso,
          updatedBy: actor.actorId,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(roadmapAdhocIdeas.id, validIdeaId),
            eq(roadmapAdhocIdeas.project, normalizedProject),
          ),
        )
        .returning();

      const [eventRow] = await tx
        .insert(roadmapChangeEvents)
        .values({
          project: normalizedProject,
          workItemId: createdEpic.id,
          adhocIdeaId: validIdeaId,
          itemTitle: existing.title,
          itemOrigin: 'adhoc',
          eventKind: 'idea_promoted',
          fromHorizon: existing.horizon,
          toHorizon: existing.horizon,
          oldTargetDate: existing.plannedTargetDate,
          newTargetDate: existing.plannedTargetDate,
          deltaDays: null,
          reason: 'Promoted Idea',
          note: `Promoted to Azure DevOps Epic #${createdEpic.id}`,
          syncedToAdo: true,
          actorId: actor.actorId,
          actorName: actor.actorName,
        })
        .returning();

      return {
        updatedIdea: ideaRow,
        overlayRow: upsertedOverlay,
        promotedEvent: eventRow,
      };
    },
  );

  return {
    idea: toIdeaDto(updatedIdea),
    event: toEventDto(promotedEvent),
    adoWorkItemId: createdEpic.id,
    overlay: toOverlayDto(overlayRow),
  };
}
