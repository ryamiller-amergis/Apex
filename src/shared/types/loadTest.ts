// ── Load Testing Module — Shared Types ────────────────────────────────────────

// ── Status and Enum Unions ─────────────────────────────────────────────────────

export type RunStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'passed'
  | 'failed'
  | 'errored'
  | 'cancelled';

export type LoadTestEngine = 'k6';

export type LoadTestFlowType = 'single' | 'multi_step';

export type LoadTestScriptSource = 'ai_generated' | 'form_builder' | 'raw';

export type LoadTestRunSource = 'app' | 'pipeline';

// ── Requirement Reference ──────────────────────────────────────────────────────

export type RequirementRef = {
  kind: 'ado_work_item' | 'apex_requirement';
  id: string;
  projectId?: string;
  /** Optional display label for UI convenience; not authoritative */
  displayLabel?: string;
};

// ── Load Profile ───────────────────────────────────────────────────────────────

export type LoadProfileStage = {
  duration: string;
  target: number;
};

export type LoadProfile = {
  vus: number;
  durationMinutes: number;
  rpsCap?: number;
  stages?: LoadProfileStage[];
};

// ── Thresholds ─────────────────────────────────────────────────────────────────

export type Threshold = {
  /** k6 metric name, e.g. http_req_duration, http_req_failed */
  metric: string;
  /** k6 threshold expression, e.g. p(95)<500 */
  expression: string;
};

export type ThresholdResult = {
  metric: string;
  expression: string;
  passed: boolean;
  /** Observed value at completion, e.g. "452.1" or 452.1 */
  observed?: string | number;
};

// ── Multi-step Flow ────────────────────────────────────────────────────────────

export type FlowStepExtraction = {
  name: string;
  source: 'json_path' | 'regex';
  expression: string;
};

export type FlowStep = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  extractions?: FlowStepExtraction[];
  tag?: string;
};

// ── Artifact References ────────────────────────────────────────────────────────

export type ArtifactRef = {
  container: string;
  key: string;
};

// ── Core Domain Types ──────────────────────────────────────────────────────────

export interface LoadTestDefinition {
  id: string;
  projectId: string;
  name: string;
  description?: string | null;
  requirementRef?: RequirementRef | null;
  targetUrl: string;
  environment: string;
  engine: LoadTestEngine;
  flowType: LoadTestFlowType;
  scriptSource: LoadTestScriptSource;
  /** Execution source of truth — the run always executes exactly this script */
  script: string;
  loadProfile: LoadProfile;
  clientThresholds: Threshold[];
  /** Default/preferred run source; actual run source stored per-run */
  runSource?: LoadTestRunSource | null;
  /** Key Vault secret references only — never plaintext credentials */
  secretRefs?: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

export interface LoadTestRun {
  id: string;
  projectId: string;
  loadTestId: string;
  status: RunStatus;
  runSource: LoadTestRunSource;
  queuedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  heartbeatAt?: string | null;
  dispatchMessageId?: string | null;
  cancelRequested: boolean;
  overallResult?: 'passed' | 'failed' | null;
  thresholdResults?: ThresholdResult[] | null;
  summaryArtifactRef?: ArtifactRef | null;
  timeseriesArtifactRef?: ArtifactRef | null;
  errorDetail?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoadTestTarget {
  id: string;
  projectId: string;
  baseUrl: string;
  environmentLabel: string;
  isReachable: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

// ── Input Types ────────────────────────────────────────────────────────────────

export interface CreateLoadTestDefinitionInput {
  name: string;
  description?: string | null;
  requirementRef?: RequirementRef | null;
  targetUrl: string;
  environment: string;
  engine?: LoadTestEngine;
  flowType?: LoadTestFlowType;
  scriptSource?: LoadTestScriptSource;
  script: string;
  loadProfile: LoadProfile;
  clientThresholds: Threshold[];
  runSource?: LoadTestRunSource | null;
  secretRefs?: Record<string, string> | null;
}

export interface CreateLoadTestRunInput {
  loadTestId: string;
  runSource: LoadTestRunSource;
  dispatchMessageId?: string | null;
}

export interface CreateLoadTestTargetInput {
  baseUrl: string;
  environmentLabel: string;
  isReachable?: boolean;
}

// ── Validation Error ───────────────────────────────────────────────────────────

export class LoadTestValidationError extends Error {
  readonly status = 422;
  readonly code: string;

  constructor(message: string, code = 'LOAD_TEST_VALIDATION_ERROR') {
    super(message);
    this.name = 'LoadTestValidationError';
    this.code = code;
  }
}
