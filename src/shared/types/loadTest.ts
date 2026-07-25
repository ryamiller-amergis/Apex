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

/** Latest-run summary attached to definition list rows (FEAT-009 list badges). */
export type LoadTestLatestRunSummary = {
  id: string;
  status: RunStatus;
  overallResult?: 'passed' | 'failed' | null;
};

/** Definition list DTO — includes optional latest-run badge fields. */
export type LoadTestDefinitionListItem = LoadTestDefinition & {
  latestRun?: LoadTestLatestRunSummary | null;
};

/** Immutable execution snapshot frozen at enqueue (A-018). */
export type LoadTestExecutionSnapshot = {
  targetUrl: string;
  script: string;
  loadProfile: LoadProfile;
  clientThresholds: Threshold[];
  /** Key Vault refs keyed by injection env name — never plaintext */
  secretRefs: Record<string, string>;
  environment: string;
  definitionName: string;
};

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
  /** Normalized allowlist host/base URL used for one-run-per-target lock */
  targetKey?: string | null;
  executionSnapshot?: LoadTestExecutionSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

/** Service Bus dispatch payload (FEAT-007 / FEAT-008). */
export type LoadTestDispatchMessage = {
  dispatchMessageId: string;
  projectId: string;
  runId: string;
  definitionId: string;
  targetUrl: string;
  /** Environment label used for final non-prod assertion at the runner */
  environment: string;
  script: string;
  loadProfile: LoadProfile;
  clientThresholds: Threshold[];
  /** Key Vault refs keyed by injection env name — never plaintext */
  secretRefs: Record<string, string>;
  callbackBaseUrl: string;
};

/** Swappable load-test execution abstraction (FEAT-008). */
export interface LoadTestRunner {
  execute(dispatch: LoadTestDispatchMessage): Promise<void>;
}

/** Unified runner/pipeline ingest body (FEAT-007 / PBI-009). */
export type LoadTestRunIngestBody = {
  dispatchMessageId: string;
  kind: 'progress' | 'final' | 'cancel_ack';
  status?: RunStatus;
  heartbeatAt?: string;
  thresholdResults?: ThresholdResult[];
  overallPassed?: boolean;
  summaryBlobRef?: string | ArtifactRef;
  timeseriesBlobRef?: string | ArtifactRef;
  errorDetail?: string;
  progress?: { vu?: number; iteration?: number; message?: string };
};

export type LoadTestRunProgressEvent = {
  type: 'status' | 'progress' | 'terminal' | 'cancel';
  runId: string;
  projectId: string;
  status: RunStatus;
  cancelRequested?: boolean;
  progress?: { vu?: number; iteration?: number; message?: string };
  thresholdResults?: ThresholdResult[] | null;
  overallResult?: 'passed' | 'failed' | null;
  at: string;
};

export interface LoadTestTarget {
  id: string;
  projectId: string;
  baseUrl: string;
  environmentLabel: string;
  isReachable: boolean;
  /** Soft-disable: inactive entries are excluded from author picker and fail allowlist checks. */
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}

// ── Input Types ────────────────────────────────────────────────────────────────

export interface CreateLoadTestDefinitionInput {
  name: string;
  description?: string | null;
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
  isActive?: boolean;
}

export interface UpdateLoadTestTargetInput {
  baseUrl?: string;
  environmentLabel?: string;
  isReachable?: boolean;
  isActive?: boolean;
}

// ── Update Input ───────────────────────────────────────────────────────────────

export interface UpdateLoadTestDefinitionInput {
  name?: string;
  description?: string | null;
  targetUrl?: string;
  environment?: string;
  engine?: LoadTestEngine;
  flowType?: LoadTestFlowType;
  scriptSource?: LoadTestScriptSource;
  script?: string;
  loadProfile?: LoadProfile;
  clientThresholds?: Threshold[];
  runSource?: LoadTestRunSource | null;
  secretRefs?: Record<string, string> | null;
}

// ── Portable Definition ─────────────────────────────────────────────────────────
// Secret-free artifact for pipeline / CI consumption.

export interface LoadTestPortableDefinition {
  id: string;
  name: string;
  engine: LoadTestEngine;
  flowType: LoadTestFlowType;
  script: string;
  loadProfile: LoadProfile;
  clientThresholds: Threshold[];
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
