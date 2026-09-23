import { isAiRunBlobRef, type AiRunBlobRef } from './aiRunV2';
import { isEffortLevel, type EffortLevel } from './effort';
import {
  INTERACTIVE_WORKFLOW_CLASSES,
  type InteractiveWorkflowClass,
} from './interactiveWorkflow';

export const DURABLE_INTERACTIVE_SPEC_VERSION = 1 as const;

export const INTERACTIVE_CLASSES = ['fast', 'agentic'] as const;
export type InteractiveClass = (typeof INTERACTIVE_CLASSES)[number];

export const INTERACTIVE_CAPABILITIES = [
  'plain-chat',
  'workspace',
  'attachments',
  'ado',
  'mcp',
  'tool-heavy',
] as const;
export type InteractiveCapability = (typeof INTERACTIVE_CAPABILITIES)[number];

export type InteractiveDeadlinePolicy = Readonly<{
  absoluteTurnMs: 300_000 | 1_200_000;
  repositoryPreparationMs: number | null;
  firstEventMs: number;
  toolCallMs: number;
}>;

export type ImmutableInteractiveAttachmentRef = Readonly<{
  attachmentId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  blobRef: AiRunBlobRef;
  materializedPath: string;
}>;

export type FrozenInteractiveMcpDescriptor =
  | Readonly<{
      kind: 'internal-proxy';
      serverName: 'ado-skills' | 'calendar-assistant' | 'maxview';
      profileId?: string;
      calendarSessionId?: string;
      enableRepoBrowse: boolean;
    }>
  | Readonly<{
      kind: 'external-http-proxy';
      serverName: string;
      url: string;
      headerEnvRefs: Readonly<Record<string, string>>;
    }>;

export type FrozenInteractiveToolGrant = Readonly<{
  userId: string;
  projectId: string;
  allowedOperations: ReadonlyArray<'ado:read' | 'ado:write'>;
  expiresAt: string;
  encryptedAdoToken: null | Readonly<{
    algorithm: 'aes-256-gcm';
    iv: string;
    ciphertext: string;
    authTag: string;
  }>;
}>;

export type DurableInteractiveTurnSpecification = Readonly<{
  schemaVersion: typeof DURABLE_INTERACTIVE_SPEC_VERSION;
  kind: 'interactive-turn';
  turnId: string;
  threadId: string;
  userId: string;
  projectId: string;
  interactiveClass: InteractiveClass;
  workflowClass: InteractiveWorkflowClass;
  model: string;
  effort: EffortLevel | null;
  skill: null | Readonly<{
    name: string;
    path: string;
    sha256: string;
    content: string;
  }>;
  currentMessage: Readonly<{
    id: string;
    text: string;
    hidden: boolean;
    attachments: ReadonlyArray<ImmutableInteractiveAttachmentRef>;
  }>;
  transcript: ReadonlyArray<
    Readonly<{
      id: string;
      role: 'user' | 'agent';
      text: string;
      timestamp: string;
    }>
  >;
  grounding: null | Readonly<{
    provider: 'ado' | 'github';
    project: string;
    repository: string;
    sha: string;
    profileId: string;
  }>;
  mcpServers: ReadonlyArray<FrozenInteractiveMcpDescriptor>;
  toolGrant: FrozenInteractiveToolGrant | null;
  currentPrompt: string;
  recreationPrompt: string;
  deadlines: InteractiveDeadlinePolicy;
}>;

export type InteractiveDispatchOutboxPayload = Readonly<{
  schemaVersion: 2;
  kind: 'interactive_dispatch';
  transport: 'dapr-actor-v2';
  runId: string;
  attemptId: string;
  attemptNumber: number;
  dispatchMessageId: string;
  threadId: string;
  userId: string;
  interactiveClass: InteractiveClass;
  workloadLane: InteractiveClass;
  capacityClass: 'interactive';
  deadlineAt: string;
}>;

export type InteractiveTurnAcceptedResponse = Readonly<{
  turnId: string;
  runId: string;
  status: 'queued' | 'dispatched';
  interactiveClass: InteractiveClass;
}>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isInteractiveClass(value: unknown): value is InteractiveClass {
  return (
    typeof value === 'string' &&
    (INTERACTIVE_CLASSES as readonly string[]).includes(value)
  );
}

function isWorkflowClass(value: unknown): value is InteractiveWorkflowClass {
  return (
    typeof value === 'string' &&
    (INTERACTIVE_WORKFLOW_CLASSES as readonly string[]).includes(value)
  );
}

function isAttachmentRef(
  value: unknown
): value is ImmutableInteractiveAttachmentRef {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.attachmentId) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.contentType) &&
    isNonNegativeInteger(value.sizeBytes) &&
    isSha256(value.sha256) &&
    isAiRunBlobRef(value.blobRef) &&
    isNonEmptyString(value.materializedPath)
  );
}

function isMcpDescriptor(
  value: unknown
): value is FrozenInteractiveMcpDescriptor {
  if (!isRecord(value)) return false;

  if (value.kind === 'internal-proxy') {
    return (
      (value.serverName === 'ado-skills' ||
        value.serverName === 'calendar-assistant' ||
        value.serverName === 'maxview') &&
      (value.profileId === undefined || isNonEmptyString(value.profileId)) &&
      (value.calendarSessionId === undefined ||
        isNonEmptyString(value.calendarSessionId)) &&
      typeof value.enableRepoBrowse === 'boolean'
    );
  }

  if (value.kind === 'external-http-proxy') {
    if (
      !isNonEmptyString(value.serverName) ||
      !isNonEmptyString(value.url) ||
      !isRecord(value.headerEnvRefs)
    ) {
      return false;
    }
    try {
      const parsed = new URL(value.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
    } catch {
      return false;
    }
    return Object.entries(value.headerEnvRefs).every(
      ([header, envRef]) => isNonEmptyString(header) && isNonEmptyString(envRef)
    );
  }

  return false;
}

function isToolGrant(value: unknown): value is FrozenInteractiveToolGrant {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.userId) ||
    !isNonEmptyString(value.projectId) ||
    !Array.isArray(value.allowedOperations) ||
    !value.allowedOperations.every(
      (operation) => operation === 'ado:read' || operation === 'ado:write'
    ) ||
    !isIsoTimestamp(value.expiresAt)
  ) {
    return false;
  }
  if (value.encryptedAdoToken === null) return true;
  if (!isRecord(value.encryptedAdoToken)) return false;
  return (
    value.encryptedAdoToken.algorithm === 'aes-256-gcm' &&
    isNonEmptyString(value.encryptedAdoToken.iv) &&
    isNonEmptyString(value.encryptedAdoToken.ciphertext) &&
    isNonEmptyString(value.encryptedAdoToken.authTag)
  );
}

function isDeadlinePolicy(
  value: unknown,
  interactiveClass: InteractiveClass
): value is InteractiveDeadlinePolicy {
  if (!isRecord(value)) return false;
  return (
    value.absoluteTurnMs === absoluteTurnMsForClass(interactiveClass) &&
    (value.repositoryPreparationMs === null ||
      isPositiveFiniteNumber(value.repositoryPreparationMs)) &&
    isPositiveFiniteNumber(value.firstEventMs) &&
    isPositiveFiniteNumber(value.toolCallMs)
  );
}

export function absoluteTurnMsForClass(
  interactiveClass: InteractiveClass
): 300_000 | 1_200_000 {
  switch (interactiveClass) {
    case 'fast':
      return 300_000;
    case 'agentic':
      return 1_200_000;
    default: {
      const unhandled: never = interactiveClass;
      throw new Error(`Unsupported interactive class: ${String(unhandled)}`);
    }
  }
}

export function isDurableInteractiveTurnSpecification(
  value: unknown
): value is DurableInteractiveTurnSpecification {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== DURABLE_INTERACTIVE_SPEC_VERSION ||
    value.kind !== 'interactive-turn' ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.threadId) ||
    !isNonEmptyString(value.userId) ||
    !isNonEmptyString(value.projectId) ||
    !isInteractiveClass(value.interactiveClass) ||
    !isWorkflowClass(value.workflowClass) ||
    !isNonEmptyString(value.model) ||
    !(value.effort === null || isEffortLevel(value.effort))
  ) {
    return false;
  }

  if (value.skill !== null) {
    if (
      !isRecord(value.skill) ||
      !isNonEmptyString(value.skill.name) ||
      !isNonEmptyString(value.skill.path) ||
      !isSha256(value.skill.sha256) ||
      typeof value.skill.content !== 'string'
    ) {
      return false;
    }
  }

  if (
    !isRecord(value.currentMessage) ||
    !isNonEmptyString(value.currentMessage.id) ||
    typeof value.currentMessage.text !== 'string' ||
    typeof value.currentMessage.hidden !== 'boolean' ||
    !Array.isArray(value.currentMessage.attachments) ||
    !value.currentMessage.attachments.every(isAttachmentRef)
  ) {
    return false;
  }

  if (
    !Array.isArray(value.transcript) ||
    !value.transcript.every(
      (entry) =>
        isRecord(entry) &&
        isNonEmptyString(entry.id) &&
        (entry.role === 'user' || entry.role === 'agent') &&
        typeof entry.text === 'string' &&
        isIsoTimestamp(entry.timestamp)
    )
  ) {
    return false;
  }

  if (value.grounding !== null) {
    if (
      !isRecord(value.grounding) ||
      !(
        value.grounding.provider === 'ado' ||
        value.grounding.provider === 'github'
      ) ||
      !isNonEmptyString(value.grounding.project) ||
      !isNonEmptyString(value.grounding.repository) ||
      !isNonEmptyString(value.grounding.sha) ||
      !isNonEmptyString(value.grounding.profileId)
    ) {
      return false;
    }
  }

  return (
    Array.isArray(value.mcpServers) &&
    value.mcpServers.every(isMcpDescriptor) &&
    (value.toolGrant === null || isToolGrant(value.toolGrant)) &&
    typeof value.currentPrompt === 'string' &&
    typeof value.recreationPrompt === 'string' &&
    isDeadlinePolicy(value.deadlines, value.interactiveClass)
  );
}

export function isInteractiveDispatchOutboxPayload(
  value: unknown
): value is InteractiveDispatchOutboxPayload {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 2 &&
    value.kind === 'interactive_dispatch' &&
    value.transport === 'dapr-actor-v2' &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.attemptId) &&
    Number.isSafeInteger(value.attemptNumber) &&
    (value.attemptNumber as number) > 0 &&
    isNonEmptyString(value.dispatchMessageId) &&
    isNonEmptyString(value.threadId) &&
    isNonEmptyString(value.userId) &&
    isInteractiveClass(value.interactiveClass) &&
    value.workloadLane === value.interactiveClass &&
    value.capacityClass === 'interactive' &&
    isIsoTimestamp(value.deadlineAt)
  );
}
