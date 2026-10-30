// ── Brainstorm artifact, versions and handoffs — shared types (FEAT-003) ──────

export const BRAINSTORM_ARTIFACT_TYPES = [
  'adr',
  'technical_design',
  'implementation_plan',
  'discovery_brief',
] as const;
export type BrainstormArtifactType = (typeof BRAINSTORM_ARTIFACT_TYPES)[number];

export const BRAINSTORM_ARTIFACT_TYPE_LABELS: Readonly<Record<BrainstormArtifactType, string>> = {
  adr: 'ADR',
  technical_design: 'Technical design',
  implementation_plan: 'Implementation plan',
  discovery_brief: 'Discovery brief',
};

export function isBrainstormArtifactType(value: unknown): value is BrainstormArtifactType {
  return typeof value === 'string' && (BRAINSTORM_ARTIFACT_TYPES as readonly string[]).includes(value);
}

export const BRAINSTORM_EXPLORE_MODE = 'explore' as const;
export type BrainstormComposerMode = typeof BRAINSTORM_EXPLORE_MODE | BrainstormArtifactType;

export const BRAINSTORM_COMPOSER_MODE_LABELS: Readonly<Record<BrainstormComposerMode, string>> = {
  explore: 'Explore',
  discovery_brief: 'Discovery brief',
  technical_design: 'Technical design',
  adr: 'ADR',
  implementation_plan: 'Implementation plan',
};

export const BRAINSTORM_COMPOSER_MODE_SUBTITLES: Readonly<Record<BrainstormComposerMode, string>> = {
  explore: 'Open Q&A and free-flow brainstorming without rewriting the artifact',
  discovery_brief: 'Frame the problem, goals, scope, and open questions',
  technical_design: 'System architecture, components, data flow, and trade-offs',
  adr: 'Record an architectural decision, options considered, and consequences',
  implementation_plan: 'Break the approach into ordered, actionable build steps',
};

export const BRAINSTORM_COMPOSER_MODES: readonly BrainstormComposerMode[] = [
  'explore',
  'discovery_brief',
  'technical_design',
  'adr',
  'implementation_plan',
] as const;

export function isBrainstormComposerMode(value: unknown): value is BrainstormComposerMode {
  return value === BRAINSTORM_EXPLORE_MODE || isBrainstormArtifactType(value);
}

/** Largest Markdown one version may hold, in UTF-8 bytes. */
export const BRAINSTORM_ARTIFACT_MAX_BYTES = 256 * 1024;
export const BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH = 80;
/** Viewers who are not the creator refresh the artifact this often while the session is active. */
export const BRAINSTORM_ARTIFACT_POLL_MS = 10_000;
/** A handoff claim older than this can be taken over by the next confirmation. */
export const BRAINSTORM_HANDOFF_CLAIM_MS = 60_000;

export const BRAINSTORM_ARTIFACT_ORIGINS = ['ai_change', 'type_switch', 'rollback'] as const;
export type BrainstormArtifactOrigin = (typeof BRAINSTORM_ARTIFACT_ORIGINS)[number];

export const BRAINSTORM_ARTIFACT_ERROR_CODES = [
  'ARTIFACT_VERSION_CONFLICT',
  'ARTIFACT_TOO_LARGE',
  'NOTHING_TO_COMPARE',
  'CHECKPOINT_EXISTS',
  'CHECKPOINT_NAME_TAKEN',
  'INVALID_CHECKPOINT_NAME',
  'VERSION_NOT_FOUND',
  'TURN_IN_PROGRESS',
  'SESSION_NOT_ACTIVE',
  'INVALID_ARTIFACT_TYPE',
  'INVALID_REQUEST',
  'ACTION_UNAVAILABLE',
  'PREVIEW_STALE',
  'IDEMPOTENCY_KEY_MISMATCH',
  'CONFIRMATION_REQUIRED',
  'HANDOFF_NOT_FOUND',
  'HANDOFF_INTERRUPTED',
] as const;
export type BrainstormArtifactErrorCode = (typeof BRAINSTORM_ARTIFACT_ERROR_CODES)[number];

/** Why an AI-requested artifact change was not applied. Stored on the assistant message. */
export const BRAINSTORM_ARTIFACT_FAILURE_CODES = [
  'ARTIFACT_VERSION_CONFLICT',
  'ARTIFACT_TOO_LARGE',
  'SESSION_NOT_ACTIVE',
  'INVALID_ARTIFACT_CHANGE',
] as const;
export type BrainstormArtifactFailureCode = (typeof BRAINSTORM_ARTIFACT_FAILURE_CODES)[number];

export const BRAINSTORM_ARTIFACT_FAILURE_SUMMARIES: Readonly<Record<BrainstormArtifactFailureCode, string>> = {
  ARTIFACT_VERSION_CONFLICT: 'The artifact changed while the collaborator was working, so its change was not applied.',
  ARTIFACT_TOO_LARGE: 'The artifact is too large. The change was not applied.',
  SESSION_NOT_ACTIVE: 'The session has ended, so the change was not applied.',
  INVALID_ARTIFACT_CHANGE: 'The collaborator sent a change that could not be applied.',
};

export function isBrainstormArtifactFailureCode(value: unknown): value is BrainstormArtifactFailureCode {
  return typeof value === 'string' && (BRAINSTORM_ARTIFACT_FAILURE_CODES as readonly string[]).includes(value);
}

export interface BrainstormArtifactChangeFailure {
  code: BrainstormArtifactFailureCode;
  summary: string;
  at: string;
}

export interface BrainstormArtifactDto {
  /** Null until the first write. */
  id: string | null;
  sessionId: string;
  type: BrainstormArtifactType | null;
  markdown: string;
  /** 0 until the first write. */
  version: number;
  updatedAt: string | null;
  lastOrigin: BrainstormArtifactOrigin | null;
  /** Checkpoint label on the current version, if one was saved. */
  checkpointName?: string | null;
  /** The latest collaborator turn's artifact change failed and nothing newer was written. */
  lastChangeFailure: BrainstormArtifactChangeFailure | null;
}

export interface BrainstormVersionSummaryDto {
  sequence: number;
  origin: BrainstormArtifactOrigin;
  checkpointName: string | null;
  artifactType: BrainstormArtifactType | null;
  authorId: string | null;
  createdAt: string;
  sizeBytes: number;
}

export interface BrainstormVersionDto extends BrainstormVersionSummaryDto {
  markdown: string;
}

export interface BrainstormVersionListDto {
  versions: BrainstormVersionSummaryDto[];
  /** Pass as `cursor` to read older versions; null when none are left. */
  nextCursor: number | null;
}

export interface BrainstormCompareDto {
  from: BrainstormVersionDto;
  to: BrainstormVersionDto;
}

export interface BrainstormTypeSwitchAcceptedDto {
  turnId: string;
  runId: string;
  messageId: string;
}

// ── Turn context carried on the frozen V2 specification ─────────────────────

export interface FrozenBrainstormArtifact {
  type: BrainstormArtifactType | null;
  version: number;
  markdown: string;
}

export type BrainstormTurnIntent =
  | { kind: 'chat' }
  | { kind: 'type_switch'; targetType: BrainstormArtifactType };

/** MCP server name and tool the collaborator uses to change the artifact. */
export const BRAINSTORM_ARTIFACT_MCP_SERVER = 'brainstorm-artifact' as const;
export const BRAINSTORM_UPDATE_ARTIFACT_TOOL = 'brainstorm_update_artifact' as const;

// ── Actions and handoffs ─────────────────────────────────────────────────────

export const BRAINSTORM_ACTION_KINDS = ['keep_standalone', 'start_workflow', 'create_direct'] as const;
export type BrainstormActionKind = (typeof BRAINSTORM_ACTION_KINDS)[number];

export type BrainstormTargetModule = 'standalone' | 'interview' | 'adr' | 'feature-request';

export const BRAINSTORM_ACTION_IDS = [
  'keep-standalone',
  'start-interview',
  'create-adr',
  'create-feature-request',
] as const;
export type BrainstormActionId = (typeof BRAINSTORM_ACTION_IDS)[number];

export function isBrainstormActionId(value: unknown): value is BrainstormActionId {
  return typeof value === 'string' && (BRAINSTORM_ACTION_IDS as readonly string[]).includes(value);
}

export type BrainstormActionState = 'available' | 'unavailable' | 'in_progress' | 'completed';
export type BrainstormHandoffState = 'previewed' | 'executing' | 'completed' | 'failed';

export interface BrainstormActionReason {
  code: string;
  text: string;
}

export interface BrainstormResultRef {
  module: BrainstormTargetModule;
  id: string | null;
  link: string | null;
}

export interface BrainstormActionDto {
  id: BrainstormActionId;
  kind: BrainstormActionKind;
  targetModule: BrainstormTargetModule;
  label: string;
  description: string;
  state: BrainstormActionState;
  reasons: BrainstormActionReason[];
  missingInformation: string[];
  handoffId: string | null;
  resultRef: BrainstormResultRef | null;
}

export interface BrainstormHandoffSummaryDto {
  handoffId: string;
  actionId: BrainstormActionId;
  kind: BrainstormActionKind;
  targetModule: BrainstormTargetModule;
  state: BrainstormHandoffState;
  artifactVersion: number;
  resultRef: BrainstormResultRef | null;
  failureCode: string | null;
  updatedAt: string;
}

export interface BrainstormActionsDto {
  artifactVersion: number;
  viewerCanAct: boolean;
  actions: BrainstormActionDto[];
  handoffs: BrainstormHandoffSummaryDto[];
}

export interface BrainstormHandoffPreviewDto {
  handoffId: string;
  idempotencyKey: string;
  state: 'previewed';
  actionId: BrainstormActionId;
  artifactVersion: number;
  target: { module: BrainstormTargetModule; label: string };
  summary: { label: string; value: string }[];
  sections: string[];
  notes: string[];
  contentSha256: string;
}

export interface BrainstormHandoffResultDto {
  handoffId: string;
  state: 'completed';
  resultRef: BrainstormResultRef;
  replayed: boolean;
}

export interface BrainstormHandoffExecutingDto {
  handoffId: string;
  state: 'executing';
}
