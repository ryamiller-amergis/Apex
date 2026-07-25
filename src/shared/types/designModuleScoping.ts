// ── Design Module — AI-assisted source scoping ───────────────────────────────

export type DesignModuleScopingConfidence = 'high' | 'medium' | 'low';

export type DesignModuleScopingStatus = 'pending' | 'ready' | 'failed' | 'cancelled';

export interface DesignModuleScopingRequest {
  /** Apex project used to resolve the connected skill repo. */
  project: string;
  /** Existing module slug when editing — enables persistent thread resume. */
  moduleSlug?: string;
  /** Existing scoping thread to resume (e.g. unsaved create session). */
  threadId?: string;
  name: string;
  description?: string | null;
  /** Current included globs (manual + prior AI proposals). */
  currentGlobs?: string[];
  /** Refine instruction; when set with an existing thread, resumes via sendMessage. */
  instruction?: string;
}

export interface DesignModuleScopingStartResponse {
  threadId: string;
}

/** Shape written by the design-module-scoping skill to `.ai-pilot/output/module-scoping.json`. */
export interface DesignModuleScopingGlobProposal {
  pattern: string;
  confidence: DesignModuleScopingConfidence;
  rationale: string;
}

export interface DesignModuleScopingResult {
  globs: DesignModuleScopingGlobProposal[];
  notes?: string;
}

export interface DesignModuleScopingResultResponse {
  status: DesignModuleScopingStatus;
  result?: DesignModuleScopingResult;
  error?: string;
}

export interface DesignModuleGlobPreviewRequest {
  sourceGlobs: string[];
}

export interface DesignModuleGlobPreviewMatch {
  pattern: string;
  files: string[];
}

export interface DesignModuleGlobPreviewResponse {
  matches: DesignModuleGlobPreviewMatch[];
}

export class DesignModuleScopingError extends Error {
  readonly code: string;

  constructor(message: string, code = 'DESIGN_MODULE_SCOPING_ERROR') {
    super(message);
    this.name = 'DesignModuleScopingError';
    this.code = code;
  }
}
