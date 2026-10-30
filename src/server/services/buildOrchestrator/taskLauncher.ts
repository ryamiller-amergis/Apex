/**
 * Launches one dispatch unit: builds the launch candidate, writes the snapshot,
 * then starts the Cloud Agent from that snapshot only.
 */
import type { BuildLaunchRefusal } from '../../../shared/types/buildLaunchSnapshot';
import {
  launchBuildAgentRun,
  writeBuildLaunchSnapshot,
} from '../buildAgentLaunchService';
import type { LaunchUnit } from './dispatcher';
import type { DispatchRunRow, DispatchTaskRow } from './dispatchStore';

export interface BuildTaskLaunchRequest {
  run: DispatchRunRow & { revisionId: string };
  unit: LaunchUnit;
  /** Members in run order. The agent run links to the first. */
  tasks: DispatchTaskRow[];
  attempt: number;
  branchName: string;
}

export type BuildTaskLaunchResult =
  | { kind: 'launched'; agentRunId: string; cloudAgentId: string; cursorRunId: string }
  /** The snapshot was refused before any SDK call. A configuration fault, not an agent failure. */
  | { kind: 'refused'; detail: string }
  | { kind: 'failed'; detail: string };

export type BuildTaskLauncher = (request: BuildTaskLaunchRequest) => Promise<BuildTaskLaunchResult>;

/** Assembles the snapshot candidate, including the prompt blob and the ordered task list. */
export type BuildLaunchCandidateBuilder = (
  request: BuildTaskLaunchRequest,
) => Promise<{ ok: true; candidate: unknown } | { ok: false; detail: string }>;

export const candidateBuilderUnavailable: BuildLaunchCandidateBuilder = async () => ({
  ok: false,
  detail: 'Apex cannot prepare instructions for build tasks yet.',
});

function refusalText(refusals: BuildLaunchRefusal[]): string {
  const codes = refusals.map((refusal) => (refusal.fieldPath ? `${refusal.code} (${refusal.fieldPath})` : refusal.code));
  return `The task launch was refused: ${codes.join(', ')}.`;
}

export function createTaskLauncher(deps: {
  buildCandidate: BuildLaunchCandidateBuilder;
  writeSnapshot?: typeof writeBuildLaunchSnapshot;
  launchRun?: typeof launchBuildAgentRun;
}): BuildTaskLauncher {
  const writeSnapshot = deps.writeSnapshot ?? writeBuildLaunchSnapshot;
  const launchRun = deps.launchRun ?? ((runId: string) => launchBuildAgentRun(runId));
  return async (request) => {
    try {
      const built = await deps.buildCandidate(request);
      if (!built.ok) return { kind: 'refused', detail: built.detail };

      const written = await writeSnapshot({ candidate: built.candidate, expectedProjectId: request.run.project });
      if (!written.ok) {
        return 'refused' in written
          ? { kind: 'refused', detail: refusalText(written.refusals) }
          : { kind: 'failed', detail: `The task launch could not be recorded (${written.reason}).` };
      }

      const launched = await launchRun(written.runId);
      if (launched.ok) {
        return {
          kind: 'launched',
          agentRunId: launched.runId,
          cloudAgentId: launched.cloudAgentId,
          cursorRunId: launched.cursorRunId,
        };
      }
      return 'refused' in launched
        ? { kind: 'refused', detail: refusalText(launched.refusals) }
        : { kind: 'failed', detail: `The agent did not start (${launched.reason}).` };
    } catch (error) {
      return { kind: 'failed', detail: error instanceof Error ? error.message : 'The agent did not start.' };
    }
  };
}
