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

export const NATIVE_READ_TELEMETRY_EVENT_NAMES = {
  flagEvaluated: 'native-read.flag.evaluated',
  capabilitySelfCheck: 'native-read.capability.self-check',
  bindingWrite: 'grounding.binding.write',
  agentRecreate: 'grounding.agent.recreate',
  denied: 'native-read.denied',
  engaged: 'native-read.engaged',
} as const;

export type NativeReadTelemetryEventName =
  (typeof NATIVE_READ_TELEMETRY_EVENT_NAMES)[keyof typeof NATIVE_READ_TELEMETRY_EVENT_NAMES];

export const NATIVE_READ_DENIAL_CATEGORIES = [
  'shell',
  'write',
  'edit',
  'delete',
  'subagent',
  'unknown-tool',
  'traversal',
  'symlink',
  'host-absolute',
  'indirect-process',
  'out-of-root',
  'unapproved-egress',
  'policy-override',
] as const;

export type NativeReadDenialCategory =
  (typeof NATIVE_READ_DENIAL_CATEGORIES)[number];

export interface NativeReadCapabilityResult {
  proven: boolean;
  reason: string;
}

type GroundingTelemetryEventContext = Pick<
  GroundingTelemetryContext,
  | 'caller'
  | 'project'
  | 'runId'
  | 'runType'
  | 'provider'
  | 'repository'
  | 'branch'
>;

export type NativeReadFlagEvaluatedEventProperties =
  GroundingTelemetryEventContext & {
    flag: 'native-read';
    outcome: 'enabled' | 'disabled' | 'error';
    reason: string;
  };

export type NativeReadCapabilitySelfCheckEventProperties =
  GroundingTelemetryEventContext & {
    outcome: 'proven' | 'not-proven' | 'error';
    selfCheckReason: string;
  };

export type GroundingBindingWriteEventProperties =
  GroundingTelemetryEventContext & {
    mode: 'local' | 'remote';
    outcome: 'success' | 'failure';
  };

export type GroundingAgentRecreateEventProperties =
  GroundingTelemetryEventContext & {
    recreateReason: string;
  };

export type NativeReadDeniedEventProperties =
  GroundingTelemetryEventContext & {
    denialCategory: NativeReadDenialCategory;
  };

export type NativeReadEngagedEventProperties = GroundingTelemetryEventContext;

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
