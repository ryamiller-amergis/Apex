import type { RepoProvider, RunType } from './runGrounding';

export const GROUNDING_ROLLOUT_STAGES = [
  'design-module',
  'interviews-documents',
  'assistants-walkthroughs',
  'convergence',
] as const;

export type GroundingRolloutStage = (typeof GROUNDING_ROLLOUT_STAGES)[number];

export const GROUNDING_ROLLOUT_STAGE_CALLERS: Record<
  GroundingRolloutStage,
  readonly string[]
> = {
  'design-module': ['design-module'],
  'interviews-documents': ['interview', 'prd', 'design-doc'],
  'assistants-walkthroughs': ['ask-apex', 'agent-home', 'walkthrough'],
  convergence: [
    'design-module',
    'interview',
    'prd',
    'design-doc',
    'ask-apex',
    'agent-home',
    'walkthrough',
  ],
};

export type GroundingGateStatus = 'pass' | 'fail' | 'unknown';

export type GroundingGateId =
  | 'fallback-rate'
  | 'warm-materialization-p95'
  | 'cold-materialization-p95'
  | 'mirror-hit-rate'
  | 'grounding-failures';

export interface GroundingGateResult {
  id: GroundingGateId;
  label: string;
  value: number | null;
  threshold: number;
  comparison: '<' | '>' | '=';
  status: GroundingGateStatus;
}

export interface GroundingGateEvaluation {
  cohort: string;
  sampleSize: number;
  minimumSampleSize: number;
  gates: GroundingGateResult[];
  eligible: boolean;
  blockingGates: GroundingGateId[];
}

export interface GroundingMetricSample {
  sampleSize: number;
  fallbackRate: number | null;
  warmMaterializationP95Ms: number | null;
  coldMaterializationP95Ms: number | null;
  mirrorHitRate: number | null;
  groundingFailureCount: number | null;
}

export interface GroundingTelemetryContext {
  caller: string;
  project: string;
  runId?: string;
  runType?: RunType;
  provider?: RepoProvider;
  repository?: string;
  branch?: string;
  [key: string]: unknown;
}

export interface GroundingNotificationVolume {
  candidateCount: number;
  filteredCount: number;
  aiEvaluatedCount: number;
  notifiedCount: number;
  deduplicatedCount: number;
}

export interface GroundingBranchMovedEvent {
  provider: RepoProvider;
  project: string;
  repository: string;
  branch: string;
  fromSha: string;
  toSha: string;
  changedFiles: string[];
}

export interface GroundingRunImpactContext {
  authorId: string;
  title: string;
  /** Exact feature-flag caller key used when this run was grounded. */
  caller: string;
  link?: string;
  /**
   * Repository-relative files or simple glob-like directory prefixes.
   * Local checkout paths and file contents are never accepted here.
   */
  scopePaths?: string[];
}
