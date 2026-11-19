/**
 * Shared chat harness command handler (TBI-009 / S6).
 *
 * Enforces command validation, `canCommandThread` access + area permission,
 * optional ADO tool grant resolution, PostgreSQL `(thread_id, command_id)`
 * atomic idempotency, all six steer rules (S-1..S-6) including the 5-steer cap,
 * cancel with 2 s confirmation timeout, idle-only summarize, retry, and
 * text-free `chat.harness.command` telemetry.
 *
 * Never logs message text, steer text, payloads, or prompts.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { agentRuns } from '../../db/schema';
import type { ChatAttachment, ChatThread } from '../../../shared/types/chat';
import {
  isHarnessAreaId,
  isHarnessCommandBody,
  type HarnessAreaId,
  type HarnessCommandBody,
  type HarnessControlMessage,
  type HarnessReceipt,
  type HarnessReceiptReason,
} from '../../../shared/types/chatHarness';
import {
  cancelRun as defaultCancelRun,
  isExplicitAdoWriteIntent,
  skillRequiresAdoOperations,
} from '../chatAgentService';
import {
  durableInteractiveTurnService,
  DurableInteractiveTurnError,
  type AdmitDurableInteractiveTurnInput,
  type DurableInteractiveToolGrantInput,
  type RetryDurableInteractiveTurnInput,
} from '../durableInteractiveTurnService';
import type { InteractiveTurnAcceptedResponse } from '../../../shared/types/durableInteractiveTurn';
import { getUserPermissions as defaultGetUserPermissions } from '../rbacService';
import { trackEvent as defaultTrackEvent } from '../telemetry';
import {
  canWriteThread as defaultCanWriteThread,
  resolveThreadAccess as defaultResolveThreadAccess,
  type ThreadAccessResult,
} from '../threadAccessService';
import { getAreaProfile, type AreaProfile } from './areaProfiles';
import {
  resolveAreaProfile as defaultResolveAreaProfile,
  toFrozenHarnessSpec,
  type ResolveAreaProfileOptions,
  type ResolvedAreaProfile,
} from './areaProfileResolver';
import {
  chatHarnessCommandRepository,
  payloadMatchesCommand,
  rowToHarnessReceipt,
  sanitizeCommandPayload,
  type ChatHarnessCommandRepository,
} from './chatHarnessCommandRepository';
import {
  chatHarnessControlBus,
  type HarnessControlAck,
} from './chatHarnessControlBus';
import {
  areaRequiresAdoToken,
  resolveHarnessToolGrant as defaultResolveHarnessToolGrant,
  validateHarnessAttachments,
  type ResolveHarnessToolGrantInput,
  type ResolveHarnessToolGrantResult,
} from './toolGrantResolver';
import {
  inferHarnessArea,
  stampThreadHarnessIfMissing as defaultStampThreadHarnessIfMissing,
} from './inferHarnessArea';

export { inferHarnessArea as inferHarnessAreaFromThread };

const MAX_ACTIVE_STEERS_PER_RUN = 5;
const DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS = 2_000;

export class HarnessCommandError extends Error {
  readonly statusCode: 400 | 404;
  readonly code: string;

  constructor(code: string, statusCode: 400 | 404, message?: string) {
    super(message ?? code);
    this.name = 'HarnessCommandError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type HarnessCommandTransport = 'socket' | 'http';

export interface HandleHarnessCommandInput {
  userId: string;
  threadId: string;
  body: unknown;
  transport: HarnessCommandTransport;
  requestAdoToken?: string | null;
}

export interface ThreadRunState {
  activeRunId: string | null;
  hasQueuedTurn: boolean;
  activeRunStatus?: 'queued' | 'dispatched' | 'running' | null;
}

export interface CanCommandThreadDeps {
  canWriteThread?: (userId: string, threadId: string) => Promise<boolean>;
  getUserPermissions?: (
    userId: string,
    project?: string,
  ) => Promise<Set<string>>;
}

export interface ChatHarnessCommandHandlerDeps {
  repository?: ChatHarnessCommandRepository;
  resolveThreadAccess?: (
    userId: string,
    threadId: string,
  ) => Promise<ThreadAccessResult | null>;
  canWriteThread?: (userId: string, threadId: string) => Promise<boolean>;
  getUserPermissions?: (
    userId: string,
    project?: string,
  ) => Promise<Set<string>>;
  resolveAreaProfile?: (
    area: string,
    project: string,
    options?: ResolveAreaProfileOptions,
  ) => Promise<ResolvedAreaProfile>;
  resolveToolGrant?: (
    input: ResolveHarnessToolGrantInput,
  ) => Promise<ResolveHarnessToolGrantResult>;
  getThreadRunState?: (threadId: string) => Promise<ThreadRunState>;
  admitTurn?: (
    input: AdmitDurableInteractiveTurnInput,
  ) => Promise<InteractiveTurnAcceptedResponse>;
  retryTurn?: (
    input: RetryDurableInteractiveTurnInput,
  ) => Promise<InteractiveTurnAcceptedResponse>;
  cancelRun?: (threadId: string) => Promise<void>;
  controlBus?: {
    publishControl: (message: HarnessControlMessage) => Promise<void>;
  };
  stampThreadHarness?: (
    threadId: string,
    area: HarnessAreaId,
    version: number,
  ) => Promise<boolean>;
  trackEvent?: (
    name: string,
    props?: Record<string, string>,
    measurements?: Record<string, number>,
  ) => void;
  cancelConfirmTimeoutMs?: number;
  now?: () => Date;
}

export interface ChatHarnessCommandHandler {
  handle(input: HandleHarnessCommandInput): Promise<HarnessReceipt>;
  handleControlAck(ack: HarnessControlAck): Promise<void>;
  dispose(): void;
}

const REASON_CODES: Record<HarnessReceiptReason, string> = {
  'Wait for this step to finish': 'steer_cap',
  'Turn had finished, sent as a new message': 'turn_ended',
  'Queued as follow-up': 'queued_followup',
  'You have read-only access to this chat': 'read_only',
  'Turn had already finished': 'already_finished',
  'Stop did not reach the agent': 'cancel_timeout',
  'Wait for this reply to finish': 'turn_running',
  'Could not summarize this conversation': 'summary_failed',
  'Command id already used': 'command_id_conflict',
  'Sign in again to continue': 'ado_reauth_required',
  'Did not reach the agent': 'did_not_reach_agent',
};

function reasonCodeFor(reason?: HarnessReceiptReason): string {
  return reason ? (REASON_CODES[reason] ?? 'other') : 'none';
}

/**
 * Decide whether a user may issue write commands on a harness thread.
 *
 * - Brainstorm: requires `threadAccess.access === 'owner'` AND `brainstorm:create`.
 * - Every other area: requires `canWriteThread(userId, threadId)` AND `profile.permission`.
 */
export async function canCommandThread(
  userId: string,
  threadAccess: ThreadAccessResult,
  profile: Pick<AreaProfile, 'area' | 'permission'>,
  deps?: CanCommandThreadDeps,
): Promise<boolean> {
  if (!userId || userId.trim().length === 0) return false;

  const loadPermissions = deps?.getUserPermissions ?? defaultGetUserPermissions;
  const permissions = await loadPermissions(
    userId,
    threadAccess.thread.kickoff.project,
  );

  if (profile.area === 'brainstorm') {
    return (
      threadAccess.access === 'owner' && permissions.has('brainstorm:create')
    );
  }

  if (!permissions.has(profile.permission)) {
    return false;
  }

  const checkWrite = deps?.canWriteThread ?? defaultCanWriteThread;
  return checkWrite(userId, threadAccess.thread.id);
}

async function defaultGetThreadRunState(
  threadId: string,
): Promise<ThreadRunState> {
  const rows = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.threadId, threadId),
        inArray(agentRuns.status, ['queued', 'dispatched', 'running']),
      ),
    )
    .orderBy(desc(agentRuns.createdAt));

  const running = rows.find(
    (r) => r.status === 'running' || r.status === 'dispatched',
  );
  const queued = rows.find((r) => r.status === 'queued');

  if (running) {
    return {
      activeRunId: running.id,
      hasQueuedTurn: Boolean(queued),
      activeRunStatus: running.status as 'dispatched' | 'running',
    };
  }
  if (queued) {
    return {
      activeRunId: queued.id,
      hasQueuedTurn: true,
      activeRunStatus: 'queued',
    };
  }
  return {
    activeRunId: null,
    hasQueuedTurn: false,
    activeRunStatus: null,
  };
}

function sendRequiresAdoToken(
  area: HarnessAreaId,
  thread: ChatThread,
  body: Extract<HarnessCommandBody, { kind: 'send' }>,
): boolean {
  if (areaRequiresAdoToken(area)) return true;
  if (isExplicitAdoWriteIntent(body.text)) return true;
  if (
    skillRequiresAdoOperations(
      body.skill?.path ??
        thread.kickoff.skillPath ??
        thread.kickoff.standupSkillPath,
      body.skill?.name ?? thread.kickoff.pillLabel,
    )
  ) {
    return true;
  }
  return false;
}

export function createChatHarnessCommandHandler(
  deps: ChatHarnessCommandHandlerDeps = {},
): ChatHarnessCommandHandler {
  const repository = deps.repository ?? chatHarnessCommandRepository;
  const resolveAccess = deps.resolveThreadAccess ?? defaultResolveThreadAccess;
  const checkWriteThread = deps.canWriteThread ?? defaultCanWriteThread;
  const loadPermissions = deps.getUserPermissions ?? defaultGetUserPermissions;
  const resolveProfile =
    deps.resolveAreaProfile ??
    ((area: string, project: string, options?: ResolveAreaProfileOptions) =>
      defaultResolveAreaProfile(area, project, undefined, options));
  const resolveToolGrant = deps.resolveToolGrant ?? defaultResolveHarnessToolGrant;
  const getRunState = deps.getThreadRunState ?? defaultGetThreadRunState;
  const admitTurn =
    deps.admitTurn ??
    ((input: AdmitDurableInteractiveTurnInput) =>
      durableInteractiveTurnService.admit(input));
  const retryTurn =
    deps.retryTurn ??
    ((input: RetryDurableInteractiveTurnInput) =>
      durableInteractiveTurnService.retry(input));
  const cancelRun = deps.cancelRun ?? defaultCancelRun;
  const controlBus = deps.controlBus ?? chatHarnessControlBus;
  const stampThreadHarness =
    deps.stampThreadHarness ?? defaultStampThreadHarnessIfMissing;
  const track = deps.trackEvent ?? defaultTrackEvent;
  const cancelConfirmTimeoutMs =
    deps.cancelConfirmTimeoutMs ?? DEFAULT_CANCEL_CONFIRM_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());

  const cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlightCommands = new Map<string, Promise<HarnessReceipt>>();

  const timerKey = (threadId: string, commandId: string): string =>
    `${threadId}:${commandId}`;

  const clearCancelTimer = (threadId: string, commandId: string): void => {
    const key = timerKey(threadId, commandId);
    const existing = cancelTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      cancelTimers.delete(key);
    }
  };

  const armCancelTimeout = (threadId: string, commandId: string): void => {
    clearCancelTimer(threadId, commandId);
    const key = timerKey(threadId, commandId);
    const timer = setTimeout(() => {
      cancelTimers.delete(key);
      void repository
        .updateReceipt(threadId, commandId, {
          status: 'rejected',
          reason: 'Stop did not reach the agent',
          expectedStatus: 'accepted',
        })
        .catch(() => {
          // Never log payload/text; errors are swallowed on background timeout.
        });
    }, cancelConfirmTimeoutMs);
    timer.unref?.();
    cancelTimers.set(key, timer);
  };

  const emitTelemetry = (
    area: HarnessAreaId,
    receipt: HarnessReceipt,
    transport: HarnessCommandTransport,
    startedAtMs: number,
  ): void => {
    track(
      'chat.harness.command',
      {
        area,
        kind: receipt.kind,
        status: receipt.status,
        reasonCode: reasonCodeFor(receipt.reason),
        transport,
        commandId: receipt.commandId,
      },
      {
        latencyMs: Math.max(0, now().getTime() - startedAtMs),
      },
    );
  };

  const admitFollowUpFromSteer = async (input: {
    threadId: string;
    commandId: string;
    userId: string;
    text: string;
    thread: ChatThread;
    area: HarnessAreaId;
    reason: 'Turn had finished, sent as a new message' | 'Queued as follow-up';
    toolGrantInput?: DurableInteractiveToolGrantInput;
    expectedStatus?: 'accepted';
  }): Promise<HarnessReceipt> => {
    const resolved = await resolveProfile(
      input.area,
      input.thread.kickoff.project,
      { settingsId: input.thread.kickoff.skillSettingsId ?? undefined },
    );

    try {
      const admitted = await admitTurn({
        turnId: input.commandId,
        threadId: input.threadId,
        userId: input.userId,
        workflowClass: resolved.workflowClass,
        text: input.text,
        modelOverride: resolved.model,
        effort: resolved.effort,
        ...(input.toolGrantInput ? { toolGrant: input.toolGrantInput } : {}),
        harness: toFrozenHarnessSpec(resolved),
      });

      const updated = await repository.updateReceipt(
        input.threadId,
        input.commandId,
        {
          status: 'queued',
          reason: input.reason,
          runId: admitted.runId,
          ...(input.expectedStatus
            ? { expectedStatus: input.expectedStatus }
            : {}),
        },
      );
      if (updated) return rowToHarnessReceipt(updated);
      return {
        commandId: input.commandId,
        kind: 'steer',
        status: 'queued',
        reason: input.reason,
        runId: admitted.runId,
        updatedAt: now().toISOString(),
      };
    } catch (err) {
      if (
        err instanceof DurableInteractiveTurnError &&
        err.code === 'TURN_ID_CONFLICT'
      ) {
        const updated = await repository.updateReceipt(
          input.threadId,
          input.commandId,
          {
            status: 'rejected',
            reason: 'Command id already used',
          },
        );
        if (updated) return rowToHarnessReceipt(updated);
        return {
          commandId: input.commandId,
          kind: 'steer',
          status: 'rejected',
          reason: 'Command id already used',
          updatedAt: now().toISOString(),
        };
      }
      throw err;
    }
  };

  return {
    async handle(input: HandleHarnessCommandInput): Promise<HarnessReceipt> {
      const startedAtMs = now().getTime();

      // Step 1: Validate body (and attachments on send)
      if (!isHarnessCommandBody(input.body)) {
        throw new HarnessCommandError(
          'invalid-command',
          400,
          'Invalid harness command body',
        );
      }
      const body: HarnessCommandBody = input.body;
      let validatedAttachments: ChatAttachment[] = [];
      if (body.kind === 'send' && body.attachments !== undefined) {
        const check = validateHarnessAttachments(body.attachments);
        if (!check.ok) {
          throw new HarnessCommandError('invalid-command', 400, check.message);
        }
        validatedAttachments = check.attachments;
      }

      // Step 2: Load thread via resolveThreadAccess
      const threadAccess = await resolveAccess(input.userId, input.threadId);
      if (!threadAccess) {
        throw new HarnessCommandError(
          'thread-not-found',
          404,
          'Thread not found',
        );
      }
      const thread = threadAccess.thread;

      // Step 3: Resolve area profile & check canCommandThread (BEFORE any DB write or dedupe lookup)
      const area = inferHarnessArea(thread);
      const profile = getAreaProfile(area);
      const allowed = await canCommandThread(input.userId, threadAccess, profile, {
        canWriteThread: checkWriteThread,
        getUserPermissions: loadPermissions,
      });
      if (!allowed) {
        const receipt: HarnessReceipt = {
          commandId: body.commandId,
          kind: body.kind,
          status: 'rejected',
          reason: 'You have read-only access to this chat',
          updatedAt: now().toISOString(),
        };
        emitTelemetry(area, receipt, input.transport, startedAtMs);
        return receipt;
      }

      // Step 4: Resolve ADO tool grant for send / retry (writes no row when sign-in required)
      let toolGrantInput: DurableInteractiveToolGrantInput | undefined;
      if (body.kind === 'send' || body.kind === 'retry') {
        const requiresAdoToken =
          body.kind === 'send'
            ? sendRequiresAdoToken(area, thread, body)
            : areaRequiresAdoToken(area);
        const grantResult = await resolveToolGrant({
          userId: input.userId,
          projectId: thread.kickoff.project,
          area,
          requiresAdoToken,
          requestToken: input.requestAdoToken ?? null,
        });
        if (!grantResult.ok) {
          const receipt: HarnessReceipt = {
            commandId: body.commandId,
            kind: body.kind,
            status: 'rejected',
            reason: grantResult.reason,
            updatedAt: now().toISOString(),
          };
          emitTelemetry(area, receipt, input.transport, startedAtMs);
          return receipt;
        }
        toolGrantInput = grantResult.toolGrantInput;
      }

      // Step 5: Atomic dedupe via insertIfAbsent
      const safePayload = sanitizeCommandPayload(body, {
        userId: input.userId,
      });
      const { inserted, row } = await repository.insertIfAbsent({
        threadId: input.threadId,
        commandId: body.commandId,
        kind: body.kind,
        status: 'accepted',
        payload: safePayload,
      });

      const key = timerKey(input.threadId, body.commandId);
      if (!inserted) {
        if (!payloadMatchesCommand(row.kind, row.payload, body)) {
          const conflictReceipt: HarnessReceipt = {
            commandId: body.commandId,
            kind: body.kind,
            status: 'rejected',
            reason: 'Command id already used',
            updatedAt: now().toISOString(),
          };
          emitTelemetry(area, conflictReceipt, input.transport, startedAtMs);
          return conflictReceipt;
        }

        // If the winning concurrent caller is still completing in this process,
        // wait for its settled receipt so both callers receive the exact same receipt.
        const inFlight = inFlightCommands.get(key);
        const existingReceipt = inFlight
          ? await inFlight
          : rowToHarnessReceipt(row);
        emitTelemetry(area, existingReceipt, input.transport, startedAtMs);
        return existingReceipt;
      }

      // Step 5.5: Upgrade pre-release unstamped threads in place on their first harness command (BR-012)
      if (!isHarnessAreaId(thread.harnessArea)) {
        await stampThreadHarness(input.threadId, area, profile.version);
      }

      // Step 6: Dispatch by command kind
      const executionPromise = (async (): Promise<HarnessReceipt> => {
        switch (body.kind) {
          case 'send': {
            const resolved = await resolveProfile(
              area,
              thread.kickoff.project,
              {
                settingsId: thread.kickoff.skillSettingsId ?? undefined,
                skillPath: body.skill?.path ?? null,
              },
            );
            try {
              const admitted = await admitTurn({
                turnId: body.commandId,
                threadId: input.threadId,
                userId: input.userId,
                workflowClass: resolved.workflowClass,
                text: body.text,
                modelOverride: body.model ?? resolved.model,
                effort: resolved.effort,
                attachments: validatedAttachments,
                turnSkill: body.skill,
                ...(toolGrantInput ? { toolGrant: toolGrantInput } : {}),
                harness: toFrozenHarnessSpec(resolved),
              });
              const updated = await repository.updateReceipt(
                input.threadId,
                body.commandId,
                {
                  status: 'accepted',
                  runId: admitted.runId,
                },
              );
              return updated
                ? rowToHarnessReceipt(updated)
                : {
                    commandId: body.commandId,
                    kind: 'send',
                    status: 'accepted',
                    runId: admitted.runId,
                    updatedAt: now().toISOString(),
                  };
            } catch (err) {
              if (
                err instanceof DurableInteractiveTurnError &&
                err.code === 'TURN_ID_CONFLICT'
              ) {
                const updated = await repository.updateReceipt(
                  input.threadId,
                  body.commandId,
                  {
                    status: 'rejected',
                    reason: 'Command id already used',
                  },
                );
                return updated
                  ? rowToHarnessReceipt(updated)
                  : {
                      commandId: body.commandId,
                      kind: 'send',
                      status: 'rejected',
                      reason: 'Command id already used',
                      updatedAt: now().toISOString(),
                    };
              }
              throw err;
            }
          }

          case 'steer': {
            const runState = await getRunState(input.threadId);

            // S-6: Active run already reached the 5-steer cap -> reject & keep row
            if (runState.activeRunId && !runState.hasQueuedTurn) {
              const steerCount = await repository.countActiveSteersForRun(
                input.threadId,
                runState.activeRunId,
              );
              if (steerCount >= MAX_ACTIVE_STEERS_PER_RUN) {
                const updated = await repository.updateReceipt(
                  input.threadId,
                  body.commandId,
                  {
                    status: 'rejected',
                    reason: 'Wait for this step to finish',
                    runId: runState.activeRunId,
                  },
                );
                return updated
                  ? rowToHarnessReceipt(updated)
                  : {
                      commandId: body.commandId,
                      kind: 'steer',
                      status: 'rejected',
                      reason: 'Wait for this step to finish',
                      runId: runState.activeRunId,
                      updatedAt: now().toISOString(),
                    };
              }
            }

            // S-5: Another turn of this thread is queued ahead -> follow-up send
            if (runState.hasQueuedTurn) {
              return admitFollowUpFromSteer({
                threadId: input.threadId,
                commandId: body.commandId,
                userId: input.userId,
                text: body.text,
                thread,
                area,
                reason: 'Queued as follow-up',
              });
            }

            // S-2: No active run -> admit as new send with turnId = commandId
            if (!runState.activeRunId) {
              return admitFollowUpFromSteer({
                threadId: input.threadId,
                commandId: body.commandId,
                userId: input.userId,
                text: body.text,
                thread,
                area,
                reason: 'Turn had finished, sent as a new message',
              });
            }

            // S-1 / S-3 / S-4: Active run exists -> associate runId, publish control, return accepted immediately
            const attached = await repository.updateReceipt(
              input.threadId,
              body.commandId,
              {
                status: 'accepted',
                runId: runState.activeRunId,
              },
            );
            await controlBus.publishControl({
              kind: 'steer',
              threadId: input.threadId,
              runId: runState.activeRunId,
              commandId: body.commandId,
              text: body.text,
              sentAt: now().toISOString(),
            });
            return attached
              ? rowToHarnessReceipt(attached)
              : {
                  commandId: body.commandId,
                  kind: 'steer',
                  status: 'accepted',
                  runId: runState.activeRunId,
                  updatedAt: now().toISOString(),
                };
          }

          case 'summarize': {
            const runState = await getRunState(input.threadId);
            if (runState.activeRunId || runState.hasQueuedTurn) {
              const updated = await repository.updateReceipt(
                input.threadId,
                body.commandId,
                {
                  status: 'rejected',
                  reason: 'Wait for this reply to finish',
                  runId: runState.activeRunId,
                },
              );
              return updated
                ? rowToHarnessReceipt(updated)
                : {
                    commandId: body.commandId,
                    kind: 'summarize',
                    status: 'rejected',
                    reason: 'Wait for this reply to finish',
                    updatedAt: now().toISOString(),
                  };
            }

            const resolved = await resolveProfile(
              area,
              thread.kickoff.project,
              { settingsId: thread.kickoff.skillSettingsId ?? undefined },
            );
            const admitted = await admitTurn({
              turnId: body.commandId,
              threadId: input.threadId,
              userId: input.userId,
              workflowClass: resolved.workflowClass,
              text: '',
              modelOverride: resolved.model,
              effort: resolved.effort,
              operation: 'summarize',
              harness: toFrozenHarnessSpec(resolved, {
                operation: 'summarize',
              }),
            });
            const updated = await repository.updateReceipt(
              input.threadId,
              body.commandId,
              {
                status: 'accepted',
                runId: admitted.runId,
              },
            );
            return updated
              ? rowToHarnessReceipt(updated)
              : {
                  commandId: body.commandId,
                  kind: 'summarize',
                  status: 'accepted',
                  runId: admitted.runId,
                  updatedAt: now().toISOString(),
                };
          }

          case 'cancel': {
            const runState = await getRunState(input.threadId);
            if (!runState.activeRunId && !runState.hasQueuedTurn) {
              const updated = await repository.updateReceipt(
                input.threadId,
                body.commandId,
                {
                  status: 'applied',
                  reason: 'Turn had already finished',
                },
              );
              return updated
                ? rowToHarnessReceipt(updated)
                : {
                    commandId: body.commandId,
                    kind: 'cancel',
                    status: 'applied',
                    reason: 'Turn had already finished',
                    updatedAt: now().toISOString(),
                  };
            }

            await cancelRun(input.threadId);
            const attached = await repository.updateReceipt(
              input.threadId,
              body.commandId,
              {
                status: 'accepted',
                runId: runState.activeRunId,
              },
            );
            if (runState.activeRunId) {
              await controlBus.publishControl({
                kind: 'cancel',
                threadId: input.threadId,
                runId: runState.activeRunId,
                commandId: body.commandId,
                sentAt: now().toISOString(),
              });
            }
            armCancelTimeout(input.threadId, body.commandId);
            return attached
              ? rowToHarnessReceipt(attached)
              : {
                  commandId: body.commandId,
                  kind: 'cancel',
                  status: 'accepted',
                  ...(runState.activeRunId ? { runId: runState.activeRunId } : {}),
                  updatedAt: now().toISOString(),
                };
          }

          case 'retry': {
            const retried = await retryTurn({
              threadId: input.threadId,
              runId: body.runId,
              userId: input.userId,
              ...(toolGrantInput ? { toolGrant: toolGrantInput } : {}),
            });
            const updated = await repository.updateReceipt(
              input.threadId,
              body.commandId,
              {
                status: 'accepted',
                runId: retried.runId,
              },
            );
            return updated
              ? rowToHarnessReceipt(updated)
              : {
                  commandId: body.commandId,
                  kind: 'retry',
                  status: 'accepted',
                  runId: retried.runId,
                  updatedAt: now().toISOString(),
                };
          }
        }
      })();

      inFlightCommands.set(key, executionPromise);
      try {
        const receipt = await executionPromise;
        // Step 7: Emit text-free telemetry
        emitTelemetry(area, receipt, input.transport, startedAtMs);
        return receipt;
      } catch (err) {
        // TBI-009 NFR: errors log commandId only (never user text or payload)
        console.error(
          JSON.stringify({
            event: 'ChatHarnessCommandError',
            commandId: body.commandId,
            kind: body.kind,
            errorType: err instanceof Error ? err.name : 'UnknownError',
          }),
        );
        throw err;
      } finally {
        inFlightCommands.delete(key);
      }
    },

    async handleControlAck(ack: HarnessControlAck): Promise<void> {
      const existing = await repository.findByCommandId(
        ack.threadId,
        ack.commandId,
      );
      if (!existing) return;

      if (ack.kind === 'cancel') {
        clearCancelTimer(ack.threadId, ack.commandId);
        if (existing.status !== 'accepted') return;
        if (ack.disposition === 'turn-ended') {
          await repository.updateReceipt(ack.threadId, ack.commandId, {
            status: 'applied',
            reason: 'Turn had already finished',
            runId: ack.runId,
            expectedStatus: 'accepted',
          });
          return;
        }
        if (ack.disposition === 'cancelled') {
          await repository.updateReceipt(ack.threadId, ack.commandId, {
            status: 'applied',
            runId: ack.runId,
            expectedStatus: 'accepted',
          });
        }
        return;
      }

      // Steer ack dispositions
      if (existing.status !== 'accepted') return;

      switch (ack.disposition) {
        case 'steered':
        case 'merged':
          await repository.updateReceipt(ack.threadId, ack.commandId, {
            status: 'applied',
            runId: ack.runId,
            expectedStatus: 'accepted',
          });
          return;
        case 'held':
          // Stays accepted until the subsequent 'steered' ack arrives after summary completes.
          return;
        case 'turn-ended': {
          const text =
            existing.payload && typeof existing.payload.text === 'string'
              ? existing.payload.text
              : null;
          const userId =
            existing.payload && typeof existing.payload.userId === 'string'
              ? existing.payload.userId
              : null;
          if (!text || !userId) return;

          const threadAccess = await resolveAccess(userId, ack.threadId);
          if (!threadAccess) return;
          const area = inferHarnessArea(threadAccess.thread);
          await admitFollowUpFromSteer({
            threadId: ack.threadId,
            commandId: ack.commandId,
            userId,
            text,
            thread: threadAccess.thread,
            area,
            reason: 'Turn had finished, sent as a new message',
            expectedStatus: 'accepted',
          });
          return;
        }
        case 'cancelled':
          return;
      }
    },

    dispose(): void {
      for (const timer of cancelTimers.values()) {
        clearTimeout(timer);
      }
      cancelTimers.clear();
    },
  };
}

export const chatHarnessCommandHandler: ChatHarnessCommandHandler =
  createChatHarnessCommandHandler();
