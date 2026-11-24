/**
 * App Service custom-tool registry and confirmation coordinator for the chat harness.
 *
 * Every area write action declared in `areaProfiles.ts` routes through here via
 * `interactiveToolProxyService`. Hard invariant (BR-001): no `writes: true` tool
 * ever mutates ADO, PRD, Design Doc, QA Lab, Brainstorm, or ServiceNow/CAB during
 * tool execution — it validates input, records a proposal, and waits for explicit
 * user confirmation via `confirmCustomToolProposal` / the area confirm endpoint.
 */
import { randomUUID } from 'node:crypto';
import type { HarnessAreaId } from '../../../shared/types/chatHarness';
import { BRAINSTORM_ARTIFACT_MAX_BYTES } from '../../../shared/types/brainstormArtifact';
import type {
  FrozenInteractiveMcpDescriptor,
  FrozenInteractiveToolGrant,
} from '../../../shared/types/durableInteractiveTurn';
import { AREA_PROFILES } from './areaProfiles';

export const PROPOSAL_RECORDED_MESSAGE =
  'Proposal recorded — waiting for explicit user confirmation';

export const CAB_CHOICE_OPTIONS = ['dry-run', 'prod'] as const;
export type CabChoiceOption = (typeof CAB_CHOICE_OPTIONS)[number];

export type CustomToolDescriptor = Extract<
  FrozenInteractiveMcpDescriptor,
  { kind: 'custom-tool' }
>;

export interface CustomToolAttemptRef {
  readonly runId: string;
  readonly attemptId: string;
  readonly dispatchMessageId: string;
}

export interface CustomToolExecutionContext {
  readonly attempt: CustomToolAttemptRef;
  readonly userId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly descriptor: CustomToolDescriptor;
  readonly toolGrant: FrozenInteractiveToolGrant | null;
  readonly delegatedAdoToken?: string | null;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

export interface CustomToolProposalResult {
  status: 'proposal_recorded' | 'completed';
  proposalId?: string;
  toolName: string;
  proxyTarget: string;
  requiresConfirmation: boolean;
  confirmEndpoint?: string;
  requiresChoice?: readonly string[];
  message: string;
  proposal?: Record<string, unknown>;
  data?: unknown;
}

export interface CustomToolProposalRecord {
  readonly proposalId: string;
  readonly area: HarnessAreaId;
  readonly permission: string;
  readonly toolName: string;
  readonly proxyTarget: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly status: 'pending' | 'applied' | 'failed';
  readonly args: Record<string, unknown>;
  readonly confirmEndpoint: string;
  readonly requiresChoice?: readonly string[];
  readonly selectedChoice?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
}

export interface RegisteredCustomTool {
  readonly area: HarnessAreaId;
  readonly permission: string;
  readonly toolName: string;
  readonly proxyTarget: string;
  readonly writes: boolean;
  readonly confirmEndpoint?: string;
  readonly requiresChoice?: readonly string[];
}

export type CustomToolRegistryErrorStatus = 400 | 403 | 404 | 502 | 503;

export class CustomToolRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: CustomToolRegistryErrorStatus = 400,
  ) {
    super(message);
    this.name = 'CustomToolRegistryError';
  }
}

export interface CustomToolDispatchDeps {
  /** Persists a staged write proposal; may return an override proposalId from DB. */
  recordProposal?: (
    record: CustomToolProposalRecord,
    context: CustomToolExecutionContext,
  ) => Promise<{ proposalId?: string } | void> | { proposalId?: string } | void;
  /** Executes a read-only (`writes: false`) area custom tool (e.g. qa-lab read tools). */
  executeRead?: (
    registration: RegisteredCustomTool,
    context: CustomToolExecutionContext,
  ) => Promise<unknown> | unknown;
  generateId?: () => string;
  now?: () => Date;
}

export interface ConfirmCustomToolProposalInput {
  readonly proposal: CustomToolProposalRecord;
  readonly actorUserId: string;
  /** Explicit user choice when `proposal.requiresChoice` is non-empty (e.g. `dry-run` | `prod`). */
  readonly choice?: string;
}

export interface ConfirmCustomToolProposalResult {
  readonly status: 'applied' | 'failed';
  readonly applied: boolean;
  readonly proposalId: string;
  readonly toolName: string;
  readonly proxyTarget: string;
  readonly choice?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly canRetry: boolean;
  readonly proposal: CustomToolProposalRecord;
}

export interface ConfirmCustomToolProposalDeps {
  /** Re-checks that the acting user has write access to the thread and area permission. */
  authorizeWrite: (input: {
    userId: string;
    projectId: string;
    threadId: string;
    area: HarnessAreaId;
    permission: string;
    proxyTarget: string;
  }) => Promise<boolean> | boolean;
  /** Runs the area's existing apply handler (PRD, Design Doc, ADO, QA Lab, Brainstorm, CAB). */
  applyProposal: (input: {
    proposal: CustomToolProposalRecord;
    actorUserId: string;
    choice?: string;
  }) => Promise<unknown>;
  /** Persists updated proposal status (`applied` or `failed`) when backed by a store. */
  updateProposalStatus?: (proposal: CustomToolProposalRecord) => Promise<void> | void;
  now?: () => Date;
}

function buildRegistryFromAreaProfiles(): ReadonlyMap<string, RegisteredCustomTool> {
  const registry = new Map<string, RegisteredCustomTool>();
  for (const profile of AREA_PROFILES.values()) {
    const confirmByTool = new Map(
      profile.writeConfirmation.map((rule) => [rule.tool, rule]),
    );
    for (const tool of profile.customTools) {
      const confirmation = confirmByTool.get(tool.name);
      const entry: RegisteredCustomTool = {
        area: profile.area,
        permission: profile.permission,
        toolName: tool.name,
        proxyTarget: tool.proxyTarget,
        writes: tool.writes,
        ...(confirmation?.confirmEndpoint
          ? { confirmEndpoint: confirmation.confirmEndpoint }
          : {}),
        ...(tool.proxyTarget === 'cab-release/propose-request'
          ? { requiresChoice: CAB_CHOICE_OPTIONS }
          : {}),
      };
      registry.set(tool.proxyTarget, entry);
    }
  }
  return registry;
}

const CUSTOM_TOOL_REGISTRY: ReadonlyMap<string, RegisteredCustomTool> =
  buildRegistryFromAreaProfiles();

export function listRegisteredCustomTools(): ReadonlyArray<RegisteredCustomTool> {
  return [...CUSTOM_TOOL_REGISTRY.values()];
}

export function getRegisteredCustomTool(
  proxyTarget: string,
): RegisteredCustomTool | undefined {
  return CUSTOM_TOOL_REGISTRY.get(proxyTarget);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(
  args: Record<string, unknown>,
  field: string,
  proxyTarget: string,
): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CustomToolRegistryError(
      'INVALID_TOOL_ARGS',
      `Custom tool "${proxyTarget}" requires a non-empty string "${field}"`,
      400,
    );
  }
  return value.trim();
}

function requireStringField(
  args: Record<string, unknown>,
  field: string,
  proxyTarget: string,
): string {
  const value = args[field];
  if (typeof value !== 'string') {
    throw new CustomToolRegistryError(
      'INVALID_TOOL_ARGS',
      `Custom tool "${proxyTarget}" requires string field "${field}"`,
      400,
    );
  }
  return value;
}

function requireEnumField(
  args: Record<string, unknown>,
  field: string,
  allowed: readonly string[],
  proxyTarget: string,
): string {
  const value = requireNonEmptyString(args, field, proxyTarget);
  if (!allowed.includes(value)) {
    throw new CustomToolRegistryError(
      'INVALID_TOOL_ARGS',
      `Custom tool "${proxyTarget}" requires "${field}" to be one of: ${allowed.join(', ')}`,
      400,
    );
  }
  return value;
}

function validateArgsForTarget(
  proxyTarget: string,
  args: Record<string, unknown>,
): void {
  switch (proxyTarget) {
    case 'ado-skills/propose-work-item-write':
      requireEnumField(
        args,
        'operation',
        ['create', 'update', 'comment', 'link'],
        proxyTarget,
      );
      requireNonEmptyString(args, 'summary', proxyTarget);
      return;

    case 'calendar-assistant/propose-work-item-changes':
      requireNonEmptyString(args, 'sessionId', proxyTarget);
      requireNonEmptyString(args, 'threadId', proxyTarget);
      if (!Array.isArray(args.changes) || args.changes.length === 0) {
        throw new CustomToolRegistryError(
          'INVALID_TOOL_ARGS',
          `Custom tool "${proxyTarget}" requires a non-empty "changes" array`,
          400,
        );
      }
      return;

    case 'prd-assistant/update-prd':
      requireNonEmptyString(args, 'prdId', proxyTarget);
      requireNonEmptyString(args, 'threadId', proxyTarget);
      requireEnumField(args, 'section', ['content', 'backlog'], proxyTarget);
      requireStringField(args, 'content', proxyTarget);
      return;

    case 'prd-assistant/add-test-case':
      requireNonEmptyString(args, 'prdId', proxyTarget);
      requireNonEmptyString(args, 'threadId', proxyTarget);
      requireNonEmptyString(args, 'pbiId', proxyTarget);
      requireNonEmptyString(args, 'title', proxyTarget);
      if (!Array.isArray(args.steps)) {
        throw new CustomToolRegistryError(
          'INVALID_TOOL_ARGS',
          `Custom tool "${proxyTarget}" requires a "steps" array`,
          400,
        );
      }
      return;

    case 'design-doc-assistant/update-design-doc':
      requireNonEmptyString(args, 'docId', proxyTarget);
      requireNonEmptyString(args, 'threadId', proxyTarget);
      requireEnumField(
        args,
        'section',
        ['design', 'tech-spec', 'assumptions'],
        proxyTarget,
      );
      requireStringField(args, 'content', proxyTarget);
      return;

    case 'qa-lab/list-suites':
    case 'qa-lab/get-cases':
      requireNonEmptyString(args, 'threadId', proxyTarget);
      return;

    case 'qa-lab/update-case':
      requireNonEmptyString(args, 'threadId', proxyTarget);
      requireNonEmptyString(args, 'localCaseId', proxyTarget);
      requireNonEmptyString(args, 'reason', proxyTarget);
      if (!isPlainObject(args.patch)) {
        throw new CustomToolRegistryError(
          'INVALID_TOOL_ARGS',
          `Custom tool "${proxyTarget}" requires a "patch" object`,
          400,
        );
      }
      return;

    case 'qa-lab/add-case':
      requireNonEmptyString(args, 'threadId', proxyTarget);
      requireNonEmptyString(args, 'pbiId', proxyTarget);
      requireNonEmptyString(args, 'reason', proxyTarget);
      if (!isPlainObject(args.testCase)) {
        throw new CustomToolRegistryError(
          'INVALID_TOOL_ARGS',
          `Custom tool "${proxyTarget}" requires a "testCase" object`,
          400,
        );
      }
      return;

    case 'qa-lab/delete-case':
    case 'qa-lab/regenerate-case':
      requireNonEmptyString(args, 'threadId', proxyTarget);
      requireNonEmptyString(args, 'localCaseId', proxyTarget);
      requireNonEmptyString(args, 'reason', proxyTarget);
      return;

    case 'qa-lab/comment-case':
      requireNonEmptyString(args, 'threadId', proxyTarget);
      requireNonEmptyString(args, 'localCaseId', proxyTarget);
      requireNonEmptyString(args, 'body', proxyTarget);
      requireNonEmptyString(args, 'reason', proxyTarget);
      return;

    case 'brainstorm-artifact/update': {
      const markdown = requireStringField(args, 'markdown', proxyTarget);
      if (Buffer.byteLength(markdown, 'utf8') > BRAINSTORM_ARTIFACT_MAX_BYTES) {
        throw new CustomToolRegistryError(
          'INVALID_TOOL_ARGS',
          `Brainstorm artifact markdown exceeds ${BRAINSTORM_ARTIFACT_MAX_BYTES} bytes`,
          400,
        );
      }
      return;
    }

    case 'cab-release/propose-request': {
      requireNonEmptyString(args, 'targetVersion', proxyTarget);
      if (args.mode !== undefined) {
        requireEnumField(args, 'mode', CAB_CHOICE_OPTIONS, proxyTarget);
      }
      return;
    }

    default:
      throw new CustomToolRegistryError(
        'UNKNOWN_PROXY_TARGET',
        `Unknown custom tool proxyTarget: ${proxyTarget}`,
        404,
      );
  }
}

/**
 * Dispatches one verified `custom-tool` call on App Service.
 *
 * Read-only tools execute via `deps.executeRead` and return `completed`.
 * Every `writes: true` tool validates input, stages a proposal, and returns
 * `proposal_recorded` with `requiresConfirmation: true` — never mutating
 * downstream data directly (BR-001).
 */
export async function dispatchHarnessCustomTool(
  context: CustomToolExecutionContext,
  deps: CustomToolDispatchDeps = {},
): Promise<CustomToolProposalResult> {
  const { descriptor, toolName, args } = context;
  const registration = CUSTOM_TOOL_REGISTRY.get(descriptor.proxyTarget);
  if (!registration) {
    throw new CustomToolRegistryError(
      'UNKNOWN_PROXY_TARGET',
      `Unknown custom tool proxyTarget: ${descriptor.proxyTarget}`,
      404,
    );
  }

  if (
    toolName !== registration.toolName ||
    descriptor.toolName !== registration.toolName
  ) {
    throw new CustomToolRegistryError(
      'UNREGISTERED_TOOL_NAME',
      `Custom tool "${toolName}" is not registered for proxyTarget "${descriptor.proxyTarget}" (expected "${registration.toolName}")`,
      400,
    );
  }

  if (descriptor.writes !== registration.writes) {
    throw new CustomToolRegistryError(
      'WRITE_FLAG_MISMATCH',
      `Descriptor write flag for "${registration.toolName}" does not match area profile`,
      403,
    );
  }

  if (!isPlainObject(args)) {
    throw new CustomToolRegistryError(
      'INVALID_TOOL_ARGS',
      `Custom tool "${registration.toolName}" arguments must be a plain object`,
      400,
    );
  }

  validateArgsForTarget(registration.proxyTarget, args);

  if (!registration.writes) {
    const data = deps.executeRead
      ? await deps.executeRead(registration, context)
      : undefined;
    return {
      status: 'completed',
      toolName: registration.toolName,
      proxyTarget: registration.proxyTarget,
      requiresConfirmation: false,
      message: `Read tool "${registration.toolName}" completed`,
      ...(data !== undefined ? { data } : {}),
    };
  }

  // Hard invariant (BR-001): every writes: true tool records a proposal and never
  // executes a write before explicit user confirmation.
  const initialProposalId = deps.generateId ? deps.generateId() : randomUUID();
  const createdAt = (deps.now ? deps.now() : new Date()).toISOString();
  const confirmEndpoint = registration.confirmEndpoint;
  if (!confirmEndpoint) {
    throw new CustomToolRegistryError(
      'MISSING_CONFIRM_ENDPOINT',
      `Write tool "${registration.toolName}" is missing a confirmation endpoint`,
      503,
    );
  }

  let record: CustomToolProposalRecord = {
    proposalId: initialProposalId,
    area: registration.area,
    permission: registration.permission,
    toolName: registration.toolName,
    proxyTarget: registration.proxyTarget,
    threadId: context.threadId,
    projectId: context.projectId,
    userId: context.userId,
    status: 'pending',
    args: { ...args },
    confirmEndpoint,
    ...(registration.requiresChoice
      ? { requiresChoice: registration.requiresChoice }
      : {}),
    createdAt,
  };

  if (deps.recordProposal) {
    const receipt = await deps.recordProposal(record, context);
    if (receipt?.proposalId && receipt.proposalId.trim().length > 0) {
      record = {
        ...record,
        proposalId: receipt.proposalId.trim(),
      };
    }
  }

  return {
    status: 'proposal_recorded',
    proposalId: record.proposalId,
    toolName: registration.toolName,
    proxyTarget: registration.proxyTarget,
    requiresConfirmation: true,
    confirmEndpoint: record.confirmEndpoint,
    ...(record.requiresChoice ? { requiresChoice: record.requiresChoice } : {}),
    message: PROPOSAL_RECORDED_MESSAGE,
    proposal: {
      proposalId: record.proposalId,
      area: record.area,
      toolName: record.toolName,
      proxyTarget: record.proxyTarget,
      status: record.status,
      args: record.args,
      confirmEndpoint: record.confirmEndpoint,
      ...(record.requiresChoice ? { requiresChoice: record.requiresChoice } : {}),
      createdAt: record.createdAt,
    },
  };
}

/**
 * Confirms and applies a staged custom-tool proposal after re-checking write
 * access and any required user choice (such as CAB `dry-run` vs `prod`).
 *
 * When the downstream apply handler throws, marks the proposal `failed`, makes
 * no applied claim (`applied: false`, `result: undefined`), and leaves the
 * proposal retryable (`canRetry: true`).
 */
export async function confirmCustomToolProposal(
  input: ConfirmCustomToolProposalInput,
  deps: ConfirmCustomToolProposalDeps,
): Promise<ConfirmCustomToolProposalResult> {
  const { proposal, actorUserId, choice } = input;

  const allowed = await deps.authorizeWrite({
    userId: actorUserId,
    projectId: proposal.projectId,
    threadId: proposal.threadId,
    area: proposal.area,
    permission: proposal.permission,
    proxyTarget: proposal.proxyTarget,
  });
  if (!allowed) {
    throw new CustomToolRegistryError(
      'WRITE_ACCESS_DENIED',
      'User does not have write access to confirm this proposal',
      403,
    );
  }

  if (proposal.status === 'applied') {
    throw new CustomToolRegistryError(
      'PROPOSAL_ALREADY_APPLIED',
      `Proposal "${proposal.proposalId}" has already been applied`,
      400,
    );
  }

  if (proposal.requiresChoice && proposal.requiresChoice.length > 0) {
    if (!choice || !proposal.requiresChoice.includes(choice)) {
      throw new CustomToolRegistryError(
        'CHOICE_REQUIRED',
        `Explicit choice required before submitting (${proposal.requiresChoice.join(' | ')})`,
        400,
      );
    }
  }

  const decidedAt = (deps.now ? deps.now() : new Date()).toISOString();

  try {
    const result = await deps.applyProposal({
      proposal,
      actorUserId,
      ...(choice !== undefined ? { choice } : {}),
    });

    const appliedProposal: CustomToolProposalRecord = {
      ...proposal,
      status: 'applied',
      decidedAt,
      decidedBy: actorUserId,
      ...(choice !== undefined ? { selectedChoice: choice } : {}),
      error: undefined,
    };
    await deps.updateProposalStatus?.(appliedProposal);

    return {
      status: 'applied',
      applied: true,
      proposalId: proposal.proposalId,
      toolName: proposal.toolName,
      proxyTarget: proposal.proxyTarget,
      ...(choice !== undefined ? { choice } : {}),
      result,
      canRetry: false,
      proposal: appliedProposal,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : String(error || 'Downstream apply failed');

    const failedProposal: CustomToolProposalRecord = {
      ...proposal,
      status: 'failed',
      decidedAt,
      decidedBy: actorUserId,
      ...(choice !== undefined ? { selectedChoice: choice } : {}),
      error: errorMessage,
    };
    await deps.updateProposalStatus?.(failedProposal);

    return {
      status: 'failed',
      applied: false,
      proposalId: proposal.proposalId,
      toolName: proposal.toolName,
      proxyTarget: proposal.proxyTarget,
      ...(choice !== undefined ? { choice } : {}),
      error: errorMessage,
      canRetry: true,
      proposal: failedProposal,
    };
  }
}
