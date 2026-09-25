/**
 * The `cursor-agent` step type.
 *
 * Its one hard rule is negative: it must never await the agent run's completion. A process-resident
 * waiter is precisely what the engine was adopted to eliminate, so the adapter enqueues, records the
 * correlation, parks the step, and returns — all in the same tick. What resumes the step is a
 * terminal agent-run event, or failing that the reconciliation sweep, neither of which needs this
 * process to still be alive. TBI-017's definition of done asks for a test that kills the process
 * right after enqueue and finds the step still suspended; that test is only meaningful because
 * nothing here is holding it open.
 *
 * Ordering matters on the failure path. The correlation row is written from the id `enqueue`
 * returns, never optimistically before the call, so a rejected enqueue cannot leave
 * `playbook_step_runs.agent_run_id` pointing at an agent run that does not exist.
 *
 * Thread-per-step rather than thread-per-run: `chat_threads.active_run_id` holds one run, so two
 * concurrent agent steps in one Playbook sharing a thread would collide.
 */
import { createThread, getThread } from '../chatAgentService';
import { enqueue } from '../agentRunLifecycleService';
import { getSkillConfig } from '../projectSettingsService';
import { getDefaultModel } from '../appSettingsService';
import {
  PlaybookMcpCapabilityError,
  resolvePlaybookMcpCapability,
} from '../playbookMcpCapabilityService';
import { parseStepInput } from './descriptorValidation';
import { assertSkillAllowed, resolveDeadlineMs } from './registry';
import {
  deadlineFromNow,
  failStepRun,
  suspendStepRun,
  PlaybookStepExecutionContext,
  PlaybookStepOutcome,
} from './stepRuns';
import type { CursorAgentStepConfig } from '../../../shared/types/playbook';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';

/**
 * How much longer the step waits than the agent run it is watching.
 *
 * The agent run and the step deadline cannot be the same instant. If they were, the reconciliation
 * sweep could expire a step in the same moment its agent run went terminal, and which of the two
 * won would decide whether the run reads as "expired" or "failed" — for the same event. Giving the
 * step a few minutes more means the terminal event always has room to land first, and the sweep
 * only ever fires when nothing arrived at all.
 */
const STEP_TYPE = 'cursor-agent';
const TERMINAL_EVENT_GRACE_MS = 5 * 60 * 1000;

export async function executeCursorAgentStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<CursorAgentStepConfig>(STEP_TYPE, context.config);

  /*
   * Before anything exists to clean up. Validating after the thread and agent run were created
   * would mean a refusal that has already cost a run, and TBI-017 is explicit that the check comes
   * first. See the registry for what this does and does not guarantee.
   */
  assertSkillAllowed(STEP_TYPE, config.skillPath);
  const mcpCapability = resolvePlaybookMcpCapability(config.mcpProfile);
  // Undefined is tolerated only for immutable versions published before FEAT-014. New publication
  // requires a profile; any explicitly named non-read profile is also refused again at execution.
  if (config.mcpProfile !== undefined && mcpCapability.mode !== 'read') {
    throw new PlaybookMcpCapabilityError(context.stepId, config.mcpProfile, mcpCapability.mode);
  }

  const deadlineMs = resolveDeadlineMs(STEP_TYPE, config.deadlineMs);
  const agentTimeoutAt = deadlineFromNow(
    Math.max(1, deadlineMs - Math.min(TERMINAL_EVENT_GRACE_MS, deadlineMs / 2))
  );
  const stepExpiresAt = deadlineFromNow(deadlineMs);

  const skillConfig = await getSkillConfig(context.project);

  // The SDK rejects a blank model id outright, so a step in a project with no configured default
  // cannot fall through to the empty string. This is the resolution the interactive lane already
  // applies, which is why the gap only ever showed up on the Playbook path.
  const model =
    config.model?.trim() || skillConfig?.defaultModel?.trim() || (await getDefaultModel());

  const existingThread = config.threadId ? await getThread(config.threadId) : null;
  if (config.threadId && !existingThread) {
    throw new Error(`Validation thread "${config.threadId}" was not found.`);
  }

  const thread = existingThread ?? await createThread(
    // Every step executes as the run's initiator, never a service principal and never the approver
    // of some earlier gate (BR-003).
    context.initiatorUserId,
    {
      project: context.project,
      repo: skillConfig?.skillRepo ?? context.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillProvider: skillConfig?.skillProvider,
      skillPath: config.skillPath,
      freeformContext: config.prompt,
      model,
      playbookMcpProfile: config.mcpProfile,
    },
    // The adapter owns the enqueue, so the thread must not start a turn of its own.
    { skipAutoKickoff: true }
  );

  const snapshot: ExecutionSnapshot = {
    prompt: config.prompt,
    model,
    workspaceRef: thread.workspaceDir,
    workflowClass: 'playbook-step',
    skillPath: config.skillPath,
    projectId: context.project,
    threadId: thread.id,
  };

  let agentRunId: string;
  try {
    // The admission-governed path every background agent run already takes. At the in-flight cap
    // this returns a queued run rather than failing, which is PBI-001's second criterion — the step
    // waits for capacity exactly like anything else, because it is not a special case.
    ({ runId: agentRunId } = await enqueue({
      threadId: thread.id,
      projectId: context.project,
      snapshot,
      timeoutAt: agentTimeoutAt,
      lane: 'background',
    }));
  } catch (error) {
    // Nothing to correlate to, so nothing is written. The step fails through the ordinary path.
    await failStepRun({
      stepRunId: context.stepRunId,
      reason: error instanceof Error ? error.message : 'Failed to enqueue the agent run',
    });
    throw error;
  }

  await suspendStepRun({
    stepRunId: context.stepRunId,
    expiresAt: stepExpiresAt,
    agentRunId,
  });

  // Returns here. The agent run is somebody else's problem until its terminal event arrives, which
  // is the entire point of this adapter.
  return { kind: 'suspended', expiresAt: stepExpiresAt, agentRunId };
}
