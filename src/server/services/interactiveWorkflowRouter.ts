/**
 * FEAT-007 / TBI-012 — interactive routing seam (fail-closed).
 *
 * Mirrors `backgroundWorkflowRouter` for the interactive lane. At the chat
 * entry point it evaluates the default-off `ai-runs-interactive` flag per
 * project + workflow `caller`. Enabled + warm capacity → dispatch the turn to
 * the thread's Dapr actor IN-CLUSTER (never Service Bus, BR-013). Disabled,
 * evaluation error, shed, or a lost admission race → the existing in-process
 * path (fail-closed, BR-017). This module has NO Service Bus publisher
 * dependency, so no interactive turn can be published to a broker.
 */
import {
  INTERACTIVE_WORKFLOW_FLAG,
  type InteractiveRouteDecision,
  type InteractiveWorkflowClass,
} from '../../shared/types/interactiveWorkflow';
import type { InteractiveActorAdmissionService } from './interactiveActorAdmissionService';
import { interactiveActorAdmissionService } from './interactiveActorAdmissionService';
import { isFeatureEnabled } from './featureFlagService';
import { trackEvent } from './telemetry';

type FeatureFlagEvaluator = (
  key: string,
  context: { userId: string; project: string; caller?: string },
) => Promise<boolean>;

export interface InteractiveWorkflowRouteInput {
  userId: string;
  project: string;
  workflowClass: InteractiveWorkflowClass;
  threadId: string;
  /** The queued interactive `agent_runs` row id to admit + dispatch. */
  runId: string;
  /** Dispatch the turn in-cluster to the thread actor (Dapr service invoke). */
  dispatchToActor(dispatch: {
    runId: string;
    dispatchMessageId: string;
  }): Promise<void> | void;
  /** Existing in-process execution path (fail-closed fallback). */
  runInProcess(): Promise<void> | void;
}

export interface InteractiveWorkflowRouterDependencies {
  isFeatureEnabled?: FeatureFlagEvaluator;
  admissionService?: InteractiveActorAdmissionService;
  trackEvent?: typeof trackEvent;
}

export interface InteractiveWorkflowRouter {
  route(input: InteractiveWorkflowRouteInput): Promise<InteractiveRouteDecision>;
}

type InProcessReason = Extract<
  InteractiveRouteDecision,
  { route: 'in-process' }
>['reason'];

export function createInteractiveWorkflowRouter(
  dependencies: InteractiveWorkflowRouterDependencies = {},
): InteractiveWorkflowRouter {
  const evaluateFlag = dependencies.isFeatureEnabled ?? isFeatureEnabled;
  const admission =
    dependencies.admissionService ?? interactiveActorAdmissionService;
  const emitEvent = dependencies.trackEvent ?? trackEvent;

  const safeTrack = (
    route: InteractiveRouteDecision['route'],
    reason: string,
    input: InteractiveWorkflowRouteInput,
  ): void => {
    try {
      emitEvent('interactive.route.decision', {
        workflowClass: input.workflowClass,
        project: input.project,
        route,
        reason,
      });
    } catch {
      // Telemetry is best effort and must never affect routing.
    }
  };

  const inProcess = async (
    input: InteractiveWorkflowRouteInput,
    reason: InProcessReason,
  ): Promise<InteractiveRouteDecision> => {
    safeTrack('in-process', reason, input);
    await input.runInProcess();
    return { route: 'in-process', reason };
  };

  return {
    async route(input): Promise<InteractiveRouteDecision> {
      let enabled = false;
      let evaluationFailed = false;
      try {
        enabled = await evaluateFlag(INTERACTIVE_WORKFLOW_FLAG, {
          userId: input.userId,
          project: input.project,
          caller: input.workflowClass,
        });
      } catch {
        evaluationFailed = true;
      }

      // Retain enabled after two stable sprints at full rollout.
      // @feature-flag:ai-runs-interactive start winner=enabled
      // @feature-flag:ai-runs-interactive disabled-start
      if (evaluationFailed) {
        return inProcess(input, 'flag-evaluation-error');
      }
      if (!enabled) {
        return inProcess(input, 'flag-disabled');
      }
      // @feature-flag:ai-runs-interactive disabled-end

      // @feature-flag:ai-runs-interactive enabled-start
      const decision = await admission.admit(input.runId);
      if (!decision.admitted) {
        // BR-014: over-capacity / lost race sheds to in-process (never queues).
        // The shed variant carries `reason`; read it via a narrow cast so the
        // access is stable under both the full server tsc and ts-jest's
        // per-file transform (which does not narrow this discriminated union).
        const shedReason = (decision as { reason?: 'shed' | 'race-lost' }).reason;
        return inProcess(input, shedReason === 'race-lost' ? 'race-lost' : 'shed');
      }

      await input.dispatchToActor({
        runId: input.runId,
        dispatchMessageId: decision.dispatchMessageId,
      });
      safeTrack('actor', decision.slot, input);
      return {
        route: 'actor',
        runId: input.runId,
        dispatchMessageId: decision.dispatchMessageId,
        slot: decision.slot,
      };
      // @feature-flag:ai-runs-interactive enabled-end
      // @feature-flag:ai-runs-interactive end
    },
  };
}

export const interactiveWorkflowRouter = createInteractiveWorkflowRouter();

export function routeInteractiveWorkflow(
  input: InteractiveWorkflowRouteInput,
): Promise<InteractiveRouteDecision> {
  return interactiveWorkflowRouter.route(input);
}
