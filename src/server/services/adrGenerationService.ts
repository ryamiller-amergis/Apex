import { applyAdrGenerationResult, startAdrWatcher } from './adrService';
import { routeBackgroundWorkflow } from './backgroundWorkflowRouter';
import { prepareBackgroundWorkflowTurn, sendMessage } from './chatAgentService';
import { propagatePipelineGrounding, runGroundingService } from './runGroundingService';

/**
 * Starts ADR generation on the background lane. The interview's grounding is
 * copied onto the generation thread before any agent run is admitted.
 */
export async function routeAdrGenerationKickoff(opts: {
  adrId: string;
  userId: string;
  project: string;
  threadId: string;
  sourceThreadId: string;
  kickoffMessage: string;
}): Promise<void> {
  const destinationRun = {
    runType: 'chat' as const,
    runId: opts.threadId,
    project: opts.project,
  };
  const reportFailure = async (detail: string): Promise<void> => {
    await runGroundingService.persistThenMarkTerminalInactive(
      destinationRun,
      async () => {
        await applyAdrGenerationResult(opts.threadId, null, detail);
      },
    );
  };

  try {
    await propagatePipelineGrounding(
      { runType: 'chat', runId: opts.sourceThreadId, project: opts.project },
      destinationRun,
      opts.userId,
      { deferMaterialization: true },
    );
  } catch (err) {
    console.warn(
      `[adr] finalize grounding propagation unavailable (adrId=${opts.adrId}):`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await routeBackgroundWorkflow({
      userId: opts.userId,
      workflowClass: 'adr',
      destinationRun,
      threadId: opts.threadId,
      prepareWorker: async () => {
        const prepared = await prepareBackgroundWorkflowTurn(
          opts.threadId,
          opts.kickoffMessage,
        );
        const targetGrounding = (
          await runGroundingService.getGroundings(destinationRun)
        ).find((grounding) => grounding.repoRole === 'target' && grounding.isActive);
        return { ...prepared, targetGrounding };
      },
      // The watcher polls the App Service workspace, which only an in-process
      // run writes to. V2 results and failures arrive through the harvest.
      runInProcess: () => {
        startAdrWatcher(opts.adrId, opts.threadId);
        return sendMessage(opts.threadId, opts.kickoffMessage, undefined, [], { hidden: true });
      },
      reportRecoverablePreparationFailure: () =>
        reportFailure('the agent run could not start'),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[adr] ADR generation kickoff failed (adrId=${opts.adrId}, threadId=${opts.threadId}): ${detail}`,
    );
    await reportFailure(detail);
  }
}
