// ── Load Testing Module — AI Generation Shared Types (FEAT-011) ───────────────

import type { LoadProfile, RequirementRef, Threshold } from './loadTest';

// ── Request / Response Shapes ───────────────────────────────────────────────────

export interface LoadTestAiGenerateRequest {
  requirementRef: RequirementRef;
  /** Freeform description of the flow to simulate (endpoints, sequence, target URL). */
  flowHints?: string;
  /** Optional caps the generated load profile / thresholds must respect. */
  loadProfileCaps?: Partial<LoadProfile>;
}

export interface LoadTestAiGenerateStartResponse {
  threadId: string;
}

export type LoadTestAiGenerationStatus = 'pending' | 'ready' | 'failed' | 'cancelled';

/** Shape written by the k6-load-test-generation Skill to `.ai-pilot/output/k6-generation.json`. */
export interface LoadTestAiGenerateResult {
  script: string;
  suggested_thresholds: Threshold[];
  notes?: string;
}

export interface LoadTestAiGenerateResultResponse {
  status: LoadTestAiGenerationStatus;
  result?: LoadTestAiGenerateResult;
  error?: string;
}

// ── Error Class ──────────────────────────────────────────────────────────────

export class LoadTestAiGenerationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'LOAD_TEST_AI_GENERATION_ERROR') {
    super(message);
    this.name = 'LoadTestAiGenerationError';
    this.code = code;
  }
}
