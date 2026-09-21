/**
 * Admits a run onto the V2 transport: specification to Blob, then a queued run
 * and a dispatched attempt whose command lands in the outbox.
 *
 * Nothing calls Service Bus here. The outbox row is the handoff, and the
 * orchestrator publishes it once capacity allows.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRunLane } from '../../../shared/types/agentRunLifecycle';
import type { AiRunV2WorkloadLane } from '../../../shared/types/aiRunV2';
import {
  runAttemptRepository,
  type RunAttemptRepository,
} from './runAttemptRepository';
import {
  createSpecificationWriter,
  type SpecificationWriter,
} from './specificationWriter';

export type AdmitV2RunInput = Readonly<{
  runId?: string;
  threadId: string;
  projectId: string;
  workloadLane: AiRunV2WorkloadLane;
  timeoutAt: string;
  specification: Record<string, unknown>;
  ownerInstance?: string | null;
}>;

export type AdmitV2RunResult =
  | {
      status: 'dispatched';
      runId: string;
      attemptId: string;
      attemptNumber: number;
      dispatchMessageId: string;
      outboxId: string | null;
    }
  | {
      status: 'active_run_conflict';
      existingRunId: string;
      existingTransportVersion: string;
      existingStatus: string;
    };

/** Document and visual work runs on the background lane; chat lanes do not. */
export function agentRunLaneFor(lane: AiRunV2WorkloadLane): AgentRunLane {
  return lane === 'fast' || lane === 'agentic'
    ? 'ai-runs-interactive'
    : 'background';
}

export function createV2AdmissionService(deps?: {
  attempts?: RunAttemptRepository;
  specifications?: SpecificationWriter;
  newRunId?: () => string;
}) {
  const attempts = deps?.attempts ?? runAttemptRepository;
  const specifications = deps?.specifications ?? createSpecificationWriter();
  const newRunId = deps?.newRunId ?? randomUUID;

  return {
    async admit(input: AdmitV2RunInput): Promise<AdmitV2RunResult> {
      const runId = input.runId ?? newRunId();
      // The specification must exist before the command references it.
      const specRef = await specifications.write({
        runId,
        attemptNumber: 1,
        specification: input.specification,
      });

      const created = await attempts.createQueuedV2Run({
        runId,
        threadId: input.threadId,
        projectId: input.projectId,
        lane: agentRunLaneFor(input.workloadLane),
        timeoutAt: input.timeoutAt,
        specRef,
        ownerInstance: input.ownerInstance ?? null,
      });
      if (created.status === 'active_run_conflict') return created;

      const dispatched = await attempts.dispatchNextAttempt({
        runId,
        workloadLane: input.workloadLane,
        specRef,
      });

      return {
        status: 'dispatched',
        runId,
        attemptId: dispatched.attemptId,
        attemptNumber: dispatched.attemptNumber,
        dispatchMessageId: dispatched.dispatchMessageId,
        outboxId: dispatched.outboxId,
      };
    },
  };
}

export type V2AdmissionService = ReturnType<typeof createV2AdmissionService>;
