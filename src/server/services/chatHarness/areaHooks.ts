/**
 * Declarative server-side lifecycle hooks for governed chat harness areas.
 *
 * Areas that need domain-specific context enrichment, pre-admission validation,
 * or post-command bookkeeping (e.g. Brainstorm ledger/artifact context, document
 * snapshot injection, interview kickoff state) register hooks here instead of
 * adding bespoke `/messages`, `/cancel`, or `/retry` HTTP routes that bypass
 * `chatHarnessCommandHandler`.
 *
 * Never log user message text, steer text, or prompt payloads inside hooks.
 */
import type { ChatAttachment, ChatThread, ChatTurnSkill } from '../../../shared/types/chat';
import type { HarnessAreaId, HarnessReceiptReason } from '../../../shared/types/chatHarness';
import type { FrozenBrainstormArtifact } from '../../../shared/types/brainstormArtifact';
import type {
  FrozenBrainstormTurn,
  InteractiveTurnAcceptedResponse,
} from '../../../shared/types/durableInteractiveTurn';
import type { ResolvedAreaProfile } from './areaProfileResolver';

export interface HarnessBeforeSendContext {
  readonly area: HarnessAreaId;
  readonly threadId: string;
  readonly userId: string;
  readonly commandId: string;
  readonly text: string;
  readonly model?: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly skill?: ChatTurnSkill;
  readonly thread: ChatThread;
  readonly resolvedProfile: ResolvedAreaProfile;
  /** True when this send was promoted from a mid-turn `steer` (S-2 / S-5 / turn-ended ack). */
  readonly fromSteerFollowUp?: boolean;
}

export type HarnessBeforeSendResult =
  | {
      readonly rejectReason: HarnessReceiptReason;
    }
  | {
      readonly rejectReason?: undefined;
      readonly text?: string;
      readonly modelOverride?: string;
      readonly hidden?: boolean;
      readonly internalContext?: string;
      readonly brainstorm?: FrozenBrainstormTurn;
      readonly areaKeyContext?: string | null;
      /** Best-effort rollback callback invoked if durable turn admission throws. */
      readonly onAdmissionFailed?: (error: unknown) => Promise<void> | void;
    };

export interface HarnessAfterSendAcceptedContext {
  readonly area: HarnessAreaId;
  readonly threadId: string;
  readonly userId: string;
  readonly commandId: string;
  readonly runId: string;
  readonly thread: ChatThread;
  readonly admitted: InteractiveTurnAcceptedResponse;
  readonly fromSteerFollowUp?: boolean;
}

export interface HarnessBeforeRetryContext {
  readonly area: HarnessAreaId;
  readonly threadId: string;
  readonly userId: string;
  readonly commandId: string;
  readonly targetRunId: string;
  readonly thread: ChatThread;
}

export type HarnessBeforeRetryResult =
  | {
      readonly rejectReason: HarnessReceiptReason;
    }
  | {
      readonly rejectReason?: undefined;
      readonly refreshedBrainstormArtifact?: FrozenBrainstormArtifact;
      /** Best-effort rollback callback invoked if durable turn retry throws. */
      readonly onRetryFailed?: (error: unknown) => Promise<void> | void;
    };

export interface HarnessAfterRetryAcceptedContext {
  readonly area: HarnessAreaId;
  readonly threadId: string;
  readonly userId: string;
  readonly commandId: string;
  readonly targetRunId: string;
  readonly runId: string;
  readonly thread: ChatThread;
  readonly retried: InteractiveTurnAcceptedResponse;
}

export interface HarnessAfterCancelAcceptedContext {
  readonly area: HarnessAreaId;
  readonly threadId: string;
  readonly userId: string;
  readonly commandId: string;
  readonly activeRunId: string | null;
  readonly thread: ChatThread;
}

export interface ChatHarnessAreaHooks {
  /** Enrich turn context, validate domain preconditions, or open domain state before admission. */
  readonly beforeSend?: (
    ctx: HarnessBeforeSendContext,
  ) => Promise<HarnessBeforeSendResult | void> | HarnessBeforeSendResult | void;
  /** Bookkeeping after durable turn admission succeeds (e.g. attach runId to a domain ledger). */
  readonly afterSendAccepted?: (
    ctx: HarnessAfterSendAcceptedContext,
  ) => Promise<void> | void;
  /** Refresh domain context or open retry state before retrying a failed/cancelled run. */
  readonly beforeRetry?: (
    ctx: HarnessBeforeRetryContext,
  ) => Promise<HarnessBeforeRetryResult | void> | HarnessBeforeRetryResult | void;
  /** Bookkeeping after durable turn retry succeeds. */
  readonly afterRetryAccepted?: (
    ctx: HarnessAfterRetryAcceptedContext,
  ) => Promise<void> | void;
  /** Bookkeeping after cancel is accepted for an active/queued run. */
  readonly afterCancelAccepted?: (
    ctx: HarnessAfterCancelAcceptedContext,
  ) => Promise<void> | void;
}

const areaHooksRegistry = new Map<HarnessAreaId, ChatHarnessAreaHooks>();

/**
 * Register lifecycle hooks for a governed chat harness area.
 * Returns an unregister function to restore clean state in tests or teardown.
 */
export function registerAreaHooks(
  area: HarnessAreaId,
  hooks: ChatHarnessAreaHooks,
): () => void {
  areaHooksRegistry.set(area, hooks);
  return () => {
    if (areaHooksRegistry.get(area) === hooks) {
      areaHooksRegistry.delete(area);
    }
  };
}

export function getAreaHooks(area: HarnessAreaId): ChatHarnessAreaHooks | undefined {
  return areaHooksRegistry.get(area);
}

export function listRegisteredAreaHookIds(): HarnessAreaId[] {
  return [...areaHooksRegistry.keys()];
}

export function clearAreaHooksForTest(): void {
  areaHooksRegistry.clear();
}
