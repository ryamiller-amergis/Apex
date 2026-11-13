export const ROADMAP_HORIZONS = ['now', 'next', 'later', 'unplanned'] as const;
export type RoadmapHorizon = (typeof ROADMAP_HORIZONS)[number];

export const ROADMAP_SCHEDULE_SOURCES = [
  'apex-plan',
  'ado-target',
  'inferred-child',
  'unscheduled',
] as const;
export type RoadmapScheduleSource = (typeof ROADMAP_SCHEDULE_SOURCES)[number];

export const ROADMAP_EFFORT_SIZES = ['S', 'M', 'L', 'XL'] as const;
export type RoadmapEffortSize = (typeof ROADMAP_EFFORT_SIZES)[number];

export const ROADMAP_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type RoadmapConfidence = (typeof ROADMAP_CONFIDENCE_LEVELS)[number];

export const ROADMAP_ITEM_ORIGINS = ['ado', 'board', 'adhoc'] as const;
export type RoadmapItemOrigin = (typeof ROADMAP_ITEM_ORIGINS)[number];

export const ROADMAP_CHANGE_EVENT_KINDS = [
  'horizon_changed',
  'date_changed',
  'baseline_locked',
  'idea_created',
  'idea_promoted',
] as const;
export type RoadmapChangeEventKind = (typeof ROADMAP_CHANGE_EVENT_KINDS)[number];

export const ROADMAP_CHANGE_REASONS = [
  'Initial Baseline',
  'Scope Expansion',
  'Dependency Delay',
  'Capacity Shift',
  'Estimate Refined',
  'Stakeholder Priority',
  'Horizon Re-prioritized',
  'Baseline Reset',
  'Promoted Idea',
] as const;
export type RoadmapChangeReason = (typeof ROADMAP_CHANGE_REASONS)[number];

export interface RoadmapProjectSettingsDto {
  project: string;
  syncDatesToAdo: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface RoadmapPlanOverlayDto {
  id: string;
  project: string;
  workItemId: number;
  workItemType: string;
  horizon: RoadmapHorizon | null;
  plannedStartDate: string | null;
  plannedTargetDate: string | null;
  baselineTargetDate: string | null;
  confidence: RoadmapConfidence | null;
  notes: string | null;
  sortOrder: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapAdhocIdeaDto {
  id: string;
  project: string;
  title: string;
  ownerLabel: string | null;
  horizon: RoadmapHorizon;
  effortSize: RoadmapEffortSize;
  confidence: RoadmapConfidence;
  releaseLabel: string | null;
  notes: string | null;
  plannedStartDate: string | null;
  plannedTargetDate: string | null;
  baselineTargetDate: string | null;
  promotedFeatureRequestId: string | null;
  promotedAdoWorkItemId: number | null;
  promotedAt: string | null;
  archived: boolean;
  sortOrder: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapChangeEventDto {
  id: string;
  project: string;
  workItemId: number | null;
  adhocIdeaId: string | null;
  itemTitle: string;
  itemOrigin: RoadmapItemOrigin;
  eventKind: RoadmapChangeEventKind;
  fromHorizon: RoadmapHorizon | null;
  toHorizon: RoadmapHorizon | null;
  oldTargetDate: string | null;
  newTargetDate: string | null;
  deltaDays: number | null;
  reason: string;
  note: string | null;
  syncedToAdo: boolean;
  actorId: string;
  actorName: string;
  createdAt: string;
}

export interface RoadmapWorkspaceResponse {
  settings: RoadmapProjectSettingsDto;
  overlays: RoadmapPlanOverlayDto[];
  ideas: RoadmapAdhocIdeaDto[];
  events: RoadmapChangeEventDto[];
}

export interface UpdateRoadmapSettingsInput {
  syncDatesToAdo: boolean;
}

export interface UpsertRoadmapOverlayInput {
  workItemType?: string;
  horizon?: RoadmapHorizon | null;
  plannedStartDate?: string | null;
  plannedTargetDate?: string | null;
  resetBaseline?: boolean;
  confidence?: RoadmapConfidence | null;
  notes?: string | null;
  sortOrder?: number;
  itemTitle: string;
  itemOrigin?: 'ado' | 'board';
  reason?: string;
  note?: string | null;
  areaPath?: string;
}

export interface CreateRoadmapAdhocIdeaInput {
  title: string;
  ownerLabel?: string | null;
  horizon?: RoadmapHorizon;
  effortSize?: RoadmapEffortSize;
  confidence?: RoadmapConfidence;
  releaseLabel?: string | null;
  notes?: string | null;
  plannedStartDate?: string | null;
  plannedTargetDate?: string | null;
  sortOrder?: number;
}

export interface UpdateRoadmapAdhocIdeaInput {
  title?: string;
  ownerLabel?: string | null;
  horizon?: RoadmapHorizon;
  effortSize?: RoadmapEffortSize;
  confidence?: RoadmapConfidence;
  releaseLabel?: string | null;
  notes?: string | null;
  plannedStartDate?: string | null;
  plannedTargetDate?: string | null;
  resetBaseline?: boolean;
  sortOrder?: number;
  reason?: string;
  note?: string | null;
}

export type RoadmapPromoteTarget = 'feature-request' | 'ado-epic';

export interface PromoteRoadmapAdhocIdeaInput {
  target: RoadmapPromoteTarget;
  areaPath?: string;
}

export interface PromoteRoadmapAdhocIdeaResponse {
  idea: RoadmapAdhocIdeaDto;
  event: RoadmapChangeEventDto;
  featureRequestId?: string;
  adoWorkItemId?: number;
  overlay?: RoadmapPlanOverlayDto;
}

export interface UpsertRoadmapOverlayResponse {
  overlay: RoadmapPlanOverlayDto;
  events: RoadmapChangeEventDto[];
  syncedToAdo: boolean;
}

export interface MutateRoadmapAdhocIdeaResponse {
  idea: RoadmapAdhocIdeaDto;
  events: RoadmapChangeEventDto[];
}
