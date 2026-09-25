/**
 * Shared environment resolution for the V2 worker entrypoints.
 *
 * Kept free of PostgreSQL imports so a worker image never opens a database
 * connection, which is the whole point of the V2 split.
 */
import {
  AI_RUN_V2_LANE_QUEUES,
  type AiRunV2WorkloadLane,
} from '../../../shared/types/aiRunV2';

export type WorkerEnvironment = Readonly<{
  namespace: string;
  commandQueue: string;
  checkpointQueue: string;
  resultQueue: string;
  artifactContainer: string;
  containerAppsExecutionId: string;
  noop: boolean;
}>;

export function resolveWorkerEnvironment(
  lane: AiRunV2WorkloadLane,
  env: NodeJS.ProcessEnv = process.env,
): WorkerEnvironment {
  const namespace =
    env.AI_PLATFORM_V2_SERVICEBUS_NAMESPACE?.trim() ||
    env.AI_RUNS_SERVICEBUS_NAMESPACE?.trim() ||
    '';

  return {
    namespace,
    commandQueue: AI_RUN_V2_LANE_QUEUES[lane],
    checkpointQueue:
      env.AI_PLATFORM_V2_CHECKPOINT_QUEUE?.trim() || 'ai-runs-v2-checkpoint',
    resultQueue: env.AI_PLATFORM_V2_RESULT_QUEUE?.trim() || 'ai-runs-v2-result',
    artifactContainer:
      env.AI_PLATFORM_V2_ARTIFACT_CONTAINER?.trim() || 'ai-run-artifacts',
    // Container Apps exposes the replica/execution name to the process; it is
    // the handle the reconciler probes when checkpoints stop arriving.
    containerAppsExecutionId:
      env.CONTAINER_APP_REPLICA_NAME?.trim() ||
      env.CONTAINER_APP_JOB_EXECUTION_NAME?.trim() ||
      env.HOSTNAME?.trim() ||
      'unknown-execution',
    noop: !namespace || env.NODE_ENV === 'test',
  };
}
