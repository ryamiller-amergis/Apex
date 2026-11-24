/**
 * Shared chat harness types, constants, and runtime guards.
 *
 * Seed area identifiers (`CHAT_AREA_IDS`, `ChatAreaId`, `isChatAreaId`,
 * `resolveChatAreaId`) come from FEAT-001 / TBI-004 for baseline scripts and
 * timing telemetry. FEAT-002 / TBI-006 adds the 12-area harness registry ids,
 * command/receipt/state frames, control channel messages, `AgentActivityItem`,
 * and hand-written runtime guards with zero client or server runtime imports.
 */
import type {
  ChatAttachment,
  ChatMessage,
  ChatThreadStatus,
  ChatTurnSkill,
} from './chat';

// ── FEAT-001 seed area identifiers (preserved for baseline & timing telemetry) ─

export const CHAT_AREA_IDS = [
  'agent-home',
  'interview',
  'adr',
  'prd-assistant',
  'design-doc-assistant',
  'ask-apex',
  'calendar-assistant',
  'qa-lab',
  'ui-lab',
  'brainstorm',
  'cab-release',
  'build-intake',
  'standup-participant',
] as const;

export type ChatAreaId = (typeof CHAT_AREA_IDS)[number];

export function isChatAreaId(value: unknown): value is ChatAreaId {
  return (
    typeof value === 'string' &&
    (CHAT_AREA_IDS as readonly string[]).includes(value)
  );
}

const WORKFLOW_TO_CHAT_AREA: Readonly<Record<string, ChatAreaId>> = {
  'agent-home': 'agent-home',
  'home-chat': 'agent-home',
  agent_home_chat: 'agent-home',
  interview: 'interview',
  adr: 'adr',
  'prd-assistant': 'prd-assistant',
  prdAssistant: 'prd-assistant',
  'design-doc-assistant': 'design-doc-assistant',
  designDocAssistant: 'design-doc-assistant',
  'ask-apex': 'ask-apex',
  ask_apex: 'ask-apex',
  'calendar-assistant': 'calendar-assistant',
  'calendar-work-item': 'calendar-assistant',
  calendarAssistant: 'calendar-assistant',
  'qa-lab': 'qa-lab',
  'ui-lab': 'ui-lab',
  brainstorm: 'brainstorm',
  'cab-release': 'cab-release',
  'build-intake': 'build-intake',
  'standup-participant': 'standup-participant',
  standup: 'standup-participant',
};

export function resolveChatAreaId(
  workflowOrArea: string | null | undefined,
): ChatAreaId | null {
  if (!workflowOrArea) return null;
  const trimmed = workflowOrArea.trim();
  if (!trimmed) return null;
  if (isChatAreaId(trimmed)) return trimmed;
  return WORKFLOW_TO_CHAT_AREA[trimmed] ?? null;
}

// ── FEAT-002 / TBI-006 shared harness contracts ───────────────────────────────

/**
 * The 12 chat areas governed by the shared harness.
 * UI Lab screen generation is a visual background run, not a chat, and has no id.
 */
export const HARNESS_AREA_IDS = [
  'agent-home',
  'interview',
  'adr',
  'prd-assistant',
  'design-doc-assistant',
  'ask-apex',
  'calendar-work-item',
  'qa-lab',
  'brainstorm',
  'cab-release',
  'build-intake',
  'standup-participant',
] as const;

export type HarnessAreaId = (typeof HARNESS_AREA_IDS)[number];

/**
 * Composer controls a harness area shows. The model dropdown is standard on every
 * area: each area takes it from `useHarnessModelPicker` and spreads it into
 * `AgentHarnessPanel`'s `composer` config. `modeOptions` and `linkedContext` are
 * optional per-area controls. An area that sets one renders its own picker through
 * `composer.modeBadge` or `slots.composerAccessory`.
 */
export type HarnessModeOptions = 'artifact-type' | null;
export type HarnessLinkedContext = 'interview-references' | null;

export interface HarnessComposerCapabilities {
  readonly modelPicker: true;
  readonly modeOptions: HarnessModeOptions;
  readonly linkedContext: HarnessLinkedContext;
}

export const HARNESS_COMPOSER_CAPABILITIES: Readonly<
  Record<HarnessAreaId, HarnessComposerCapabilities>
> = {
  'agent-home': { modelPicker: true, modeOptions: null, linkedContext: null },
  interview: { modelPicker: true, modeOptions: null, linkedContext: 'interview-references' },
  adr: { modelPicker: true, modeOptions: null, linkedContext: null },
  'prd-assistant': { modelPicker: true, modeOptions: null, linkedContext: null },
  'design-doc-assistant': { modelPicker: true, modeOptions: null, linkedContext: null },
  'ask-apex': { modelPicker: true, modeOptions: null, linkedContext: null },
  'calendar-work-item': { modelPicker: true, modeOptions: null, linkedContext: null },
  'qa-lab': { modelPicker: true, modeOptions: null, linkedContext: null },
  brainstorm: { modelPicker: true, modeOptions: 'artifact-type', linkedContext: null },
  'cab-release': { modelPicker: true, modeOptions: null, linkedContext: null },
  'build-intake': { modelPicker: true, modeOptions: null, linkedContext: null },
  'standup-participant': { modelPicker: true, modeOptions: null, linkedContext: null },
};

export const HARNESS_COMMAND_KINDS = [
  'send',
  'steer',
  'summarize',
  'cancel',
  'retry',
] as const;

export type HarnessCommandKind = (typeof HARNESS_COMMAND_KINDS)[number];

export const HARNESS_RECEIPT_STATUSES = [
  'accepted',
  'applied',
  'rejected',
  'queued',
] as const;

export type HarnessReceiptStatus = (typeof HARNESS_RECEIPT_STATUSES)[number];

/** Closed set of user-facing receipt reason strings; never accepts free-form input. */
export const HARNESS_RECEIPT_REASONS = [
  'Wait for this step to finish',
  'Turn had finished, sent as a new message',
  'Queued as follow-up',
  'You have read-only access to this chat',
  'Turn had already finished',
  'Stop did not reach the agent',
  'Wait for this reply to finish',
  'Could not summarize this conversation',
  'Command id already used',
  'Sign in again to continue',
  'Did not reach the agent',
] as const;

export type HarnessReceiptReason = (typeof HARNESS_RECEIPT_REASONS)[number];

export const HARNESS_CONTEXT_KINDS = [
  'prd',
  'brainstorm-session',
  'interview',
  'adr',
  'design-doc',
  'release',
  'qa-suite',
  'standup-session',
  'build-intake',
  'work-item',
] as const;

export type HarnessContextKind = (typeof HARNESS_CONTEXT_KINDS)[number];

export type HarnessContextRef = Readonly<{
  kind: HarnessContextKind;
  id: string;
}>;

export const HARNESS_RECREATE_REASONS = [
  'deploy',
  'folder-change',
  'replica-move',
  'sdk-version',
  'idle-eviction',
  'unknown',
] as const;

export type HarnessRecreateReason = (typeof HARNESS_RECREATE_REASONS)[number];

export const HARNESS_AGENT_PHASES = [
  'idle',
  'starting',
  'resuming',
  'recreating',
  'running',
  'summarizing',
] as const;

export type HarnessAgentPhase = (typeof HARNESS_AGENT_PHASES)[number];

// ── Command, receipt, state, and snapshot contracts ───────────────────────────

export type HarnessSendCommand = {
  commandId: string;
  kind: 'send';
  text: string;
  model?: string;
  attachments?: ChatAttachment[];
  skill?: ChatTurnSkill;
};

export type HarnessSteerCommand = {
  commandId: string;
  kind: 'steer';
  text: string;
};

export type HarnessSummarizeCommand = {
  commandId: string;
  kind: 'summarize';
};

export type HarnessCancelCommand = {
  commandId: string;
  kind: 'cancel';
};

export type HarnessRetryCommand = {
  commandId: string;
  kind: 'retry';
  runId: string;
};

export type HarnessCommandBody =
  | HarnessSendCommand
  | HarnessSteerCommand
  | HarnessSummarizeCommand
  | HarnessCancelCommand
  | HarnessRetryCommand;

export type HarnessReceipt = {
  commandId: string;
  kind: HarnessCommandKind;
  status: HarnessReceiptStatus;
  reason?: HarnessReceiptReason;
  runId?: string;
  updatedAt: string;
};

export type HarnessSummaryMarker = {
  id: string;
  source: 'auto' | 'user';
  fallback: boolean;
  createdAt: string;
};

export type HarnessPendingCommand = {
  commandId: string;
  kind: HarnessCommandKind;
  status: 'accepted' | 'queued';
};

export type HarnessThreadState = {
  threadStatus: ChatThreadStatus;
  activeRunId: string | null;
  phase: HarnessAgentPhase;
  harnessArea: HarnessAreaId | null;
  pendingCommands: Array<HarnessPendingCommand>;
  latestSummary: HarnessSummaryMarker | null;
  canWrite?: boolean;
};

export type HarnessThreadSnapshot = {
  messages: ChatMessage[];
  state: HarnessThreadState;
  latestSummary: HarnessSummaryMarker | null;
  canWrite?: boolean;
};

// ── Gateway frames ────────────────────────────────────────────────────────────

export type HarnessCommandFrame = { type: 'command' } & HarnessCommandBody;

export type HarnessReceiptFrame = {
  type: 'receipt';
  receipt: HarnessReceipt;
};

export type HarnessStateFrame = {
  type: 'state';
  state: HarnessThreadState;
};

export type HarnessErrorFrame = {
  type: 'error';
  code: string;
  commandId?: string;
};

export type HarnessGatewayOutboundFrame =
  | HarnessReceiptFrame
  | HarnessStateFrame
  | HarnessErrorFrame;

// ── General activity item (generalized from BrainstormActivityItem) ──────────

export interface AgentActivityToolItem {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'error';
  target?: string | null;
  result?: string;
}

export interface AgentActivityItem {
  id: string;
  kind: 'thinking' | 'tool' | 'tool-group' | 'summary';
  text?: string;
  toolName?: string;
  status?: 'running' | 'completed' | 'error' | 'fallback';
  target?: string | null;
  result?: string;
  tools?: ReadonlyArray<AgentActivityToolItem>;
}

// ── Control channel messages (App Service -> interactive actor) ──────────────

export type HarnessSteerControlMessage = Readonly<{
  kind: 'steer';
  threadId: string;
  runId: string;
  commandId: string;
  text: string;
  sentAt: string;
}>;

export type HarnessCancelControlMessage = Readonly<{
  kind: 'cancel';
  threadId: string;
  runId: string;
  commandId: string;
  sentAt: string;
}>;

export type HarnessControlMessage =
  | HarnessSteerControlMessage
  | HarnessCancelControlMessage;

/** Slow-path pending control item delivered on AiRunIngestResponse. */
export type HarnessPendingControl = Readonly<{
  commandId: string;
  kind: 'steer' | 'cancel';
  text?: string;
}>;

// ── Hand-written runtime guards ──────────────────────────────────────────────

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const timezone = match[8];
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ] as const;
  const maxDay = daysPerMonth[month - 1];

  if (
    maxDay === undefined ||
    day < 1 ||
    day > maxDay ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (
    timezone !== 'Z' &&
    (offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0))
  ) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    typeof value.type === 'string' &&
    typeof value.size === 'number' &&
    Number.isFinite(value.size) &&
    value.size >= 0 &&
    typeof value.content === 'string' &&
    (value.encoding === undefined || value.encoding === 'base64')
  );
}

function isChatTurnSkill(value: unknown): value is ChatTurnSkill {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.name) && isNonEmptyString(value.path);
}

export function isHarnessAreaId(value: unknown): value is HarnessAreaId {
  return (
    typeof value === 'string' &&
    (HARNESS_AREA_IDS as readonly string[]).includes(value)
  );
}

export function isHarnessCommandKind(value: unknown): value is HarnessCommandKind {
  return (
    typeof value === 'string' &&
    (HARNESS_COMMAND_KINDS as readonly string[]).includes(value)
  );
}

export function isHarnessReceiptStatus(
  value: unknown,
): value is HarnessReceiptStatus {
  return (
    typeof value === 'string' &&
    (HARNESS_RECEIPT_STATUSES as readonly string[]).includes(value)
  );
}

export function isHarnessReceiptReason(
  value: unknown,
): value is HarnessReceiptReason {
  return (
    typeof value === 'string' &&
    (HARNESS_RECEIPT_REASONS as readonly string[]).includes(value)
  );
}

export function isHarnessContextKind(value: unknown): value is HarnessContextKind {
  return (
    typeof value === 'string' &&
    (HARNESS_CONTEXT_KINDS as readonly string[]).includes(value)
  );
}

export function isHarnessContextRef(value: unknown): value is HarnessContextRef {
  if (!isRecord(value)) return false;
  return isHarnessContextKind(value.kind) && isNonEmptyString(value.id);
}

export function isHarnessRecreateReason(
  value: unknown,
): value is HarnessRecreateReason {
  return (
    typeof value === 'string' &&
    (HARNESS_RECREATE_REASONS as readonly string[]).includes(value)
  );
}

export function isHarnessAgentPhase(value: unknown): value is HarnessAgentPhase {
  return (
    typeof value === 'string' &&
    (HARNESS_AGENT_PHASES as readonly string[]).includes(value)
  );
}

export function isHarnessCommandBody(value: unknown): value is HarnessCommandBody {
  if (!isRecord(value)) return false;
  if (!isCanonicalUuid(value.commandId)) return false;

  switch (value.kind) {
    case 'send': {
      if (typeof value.text !== 'string') return false;
      if (value.model !== undefined && !isNonEmptyString(value.model)) {
        return false;
      }
      if (value.skill !== undefined && !isChatTurnSkill(value.skill)) {
        return false;
      }
      if (
        value.attachments !== undefined &&
        (!Array.isArray(value.attachments) ||
          !value.attachments.every(isChatAttachment))
      ) {
        return false;
      }
      const hasText = value.text.trim().length > 0;
      const hasAttachments =
        Array.isArray(value.attachments) && value.attachments.length > 0;
      return hasText || hasAttachments;
    }
    case 'steer':
      return isNonEmptyString(value.text);
    case 'summarize':
    case 'cancel':
      return true;
    case 'retry':
      return isNonEmptyString(value.runId);
    default:
      return false;
  }
}

export function isHarnessCommandFrame(
  value: unknown,
): value is HarnessCommandFrame {
  if (!isRecord(value) || value.type !== 'command') return false;
  return isHarnessCommandBody(value);
}

export function isHarnessControlMessage(
  value: unknown,
): value is HarnessControlMessage {
  if (!isRecord(value)) return false;
  if (
    !isCanonicalUuid(value.threadId) ||
    !isNonEmptyString(value.runId) ||
    !isCanonicalUuid(value.commandId) ||
    !isIsoTimestamp(value.sentAt)
  ) {
    return false;
  }
  if (value.kind === 'steer') {
    return isNonEmptyString(value.text);
  }
  if (value.kind === 'cancel') {
    return true;
  }
  return false;
}
