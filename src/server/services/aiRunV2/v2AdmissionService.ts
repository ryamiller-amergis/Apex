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
import type { VisualSubjectKind } from '../../../shared/types/aiRunV2VisualSpec';
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
  /** Optional copy persisted on the run header for generic completion/usage. */
  executionSnapshot?: Record<string, unknown>;
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

/**
 * Visual subjects have no chat thread, and `uq_agent_runs_v2_active_thread`
 * allows one active V2 run per thread. A PRD generates many prototypes at
 * once, so each needs its own run identity or the second is refused.
 *
 * The kind picks the namespace because each owner sweeps for its own threads
 * by id; a shared prefix would offer one owner a finished run belonging to
 * another, whose artifact it cannot read.
 */
export function visualRunThreadId(
  subjectKind: VisualSubjectKind,
  subjectId: string,
): string {
  return `${visualRunThreadPrefix(subjectKind)}${subjectId}`;
}

export function visualRunThreadPrefix(
  subjectKind: VisualSubjectKind,
): string {
  switch (subjectKind) {
    case 'design-prototype':
      return 'prototype:';
    case 'ui-lab-screen':
      return 'ui-lab:';
    default: {
      const unhandled: never = subjectKind;
      throw new Error(`Unsupported visual subjectKind: ${String(unhandled)}`);
    }
  }
}

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

      const created = await attempts.createDispatchedV2Run({
        runId,
        threadId: input.threadId,
        projectId: input.projectId,
        lane: agentRunLaneFor(input.workloadLane),
        workloadLane: input.workloadLane,
        timeoutAt: input.timeoutAt,
        specRef,
        executionSnapshot: input.executionSnapshot,
        ownerInstance: input.ownerInstance ?? null,
      });
      if (created.status === 'active_run_conflict') return created;

      return {
        status: 'dispatched',
        runId,
        attemptId: created.attemptId,
        attemptNumber: created.attemptNumber,
        dispatchMessageId: created.dispatchMessageId,
        outboxId: created.outboxId,
      };
    },
  };
}

export type V2AdmissionService = ReturnType<typeof createV2AdmissionService>;
