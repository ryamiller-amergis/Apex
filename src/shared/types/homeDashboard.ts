/**
 * Shared contract for the Agent Home Pipeline Status Dashboard (FEAT-001).
 *
 * `GET /api/home-dashboard` returns `HomeDashboardPayload`. A tile the caller is
 * not authorized to see is `null` in the payload rather than an empty tile.
 */

/** Artifact types that carry a frozen done event (see `artifact_done_events`). */
export type ArtifactDoneEventType =
  | 'interview'
  | 'prd'
  | 'test_case'
  | 'design_prototype'
  | 'design_doc';

export type TileStatus = 'ok' | 'empty' | 'error';
export type HomeDashboardScope = 'mine' | 'team';

export interface TileResult<T> {
  status: TileStatus;
  data: T | null;
  /** Present only when status === 'error' and a prior successful fetch exists. */
  lastKnownData?: T;
  /** Present only when status === 'error'. */
  message?: string;
}

export interface PipelineGroupRow {
  id: string;
  name: string;
  route: string;
  updatedAt: string;
  ageDays: number;
  /**
   * Why this row is still in the pipeline, e.g. "No PRD generated". An artifact's
   * own badge can read Complete while the pipeline stalled behind it, so every row
   * has to say which stage it is waiting on.
   */
  reason: string;
}

export interface PipelineGroup {
  key: 'interview' | 'prd' | 'testCase' | 'prototype' | 'designDoc';
  label: string;
  count: number;
  rows: PipelineGroupRow[];
  viewAllHref: string;
}

export interface IncompletePipelineData {
  groups: PipelineGroup[];
  updatedAt: string;
}

export interface CycleTimeKpi {
  /** Null when no completed items fall inside the window. */
  medianDays: number | null;
  sampleSize: number;
  windowDays: 90;
  /**
   * Present only when this KPI's own source query failed. Distinguishes
   * "unavailable" from the empty window, which is `medianDays: null` with no
   * flag; sibling KPIs on the same card still carry their values.
   */
  unavailable?: true;
}

export interface ArtifactCycleTimeData {
  interview: CycleTimeKpi;
  prd: CycleTimeKpi;
  testCase: CycleTimeKpi;
  /** Omitted (not present) when Design Prototypes are disabled for the project. */
  prototype?: CycleTimeKpi;
  designDoc: CycleTimeKpi;
}

export interface MyWorkData {
  ready: number;
  inProgress: number;
  cycleTime: CycleTimeKpi;
}

export interface OpenBugsRow {
  pbiId: string;
  title: string;
  openBugCount: number;
  updatedAt: string;
}

export interface OpenBugsOnPbisData {
  totalOpenBugs: number;
  rows: OpenBugsRow[];
}

export interface DevToProductionData {
  medianDays: number | null;
  sampleSize: number;
  windowDays: 90;
}

/** Bugs created in the window per PBI created in the same window. */
export interface BugToPbiRatioData {
  /** Unique child Bugs created in the window. */
  bugCount: number;
  /** Unique PBIs / User Stories created in the window. */
  pbiCount: number;
  /** `bugCount / pbiCount`, one decimal. Null when no PBIs were created. */
  ratio: number | null;
  windowDays: 90;
}

export interface HomeDashboardPayload {
  incompletePipeline: TileResult<IncompletePipelineData> | null;
  artifactCycleTime: TileResult<ArtifactCycleTimeData> | null;
  myWork: TileResult<MyWorkData> | null;
  openBugsOnPbis: TileResult<OpenBugsOnPbisData> | null;
  bugToPbiRatio: TileResult<BugToPbiRatioData> | null;
  devToProduction: TileResult<DevToProductionData> | null;
}
