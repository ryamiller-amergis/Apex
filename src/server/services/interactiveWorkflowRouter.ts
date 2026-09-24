import {
  INTERACTIVE_WORKFLOW_FLAG,
  type InteractiveRouteDecision,
  type InteractiveWorkflowClass,
} from '../../shared/types/interactiveWorkflow';
import type { InteractiveTurnAcceptedResponse } from '../../shared/types/durableInteractiveTurn';
import type { InteractiveActorAdmissionService } from './interactiveActorAdmissionService';
import { interactiveActorAdmissionService } from './interactiveActorAdmissionService';
import { isFeatureEnabled } from './featureFlagService';
import { trackEvent } from './telemetry';

const V2_TRANSPORT_FLAG = 'ai-runs-v2-transport';

type FeatureFlagEvaluator = (
  key: string,
  context: { userId: string; project: string; caller?: string },
) => Promise<boolean>;

export interface InteractiveWorkflowRouteInput {
  userId: string;
  project: string;
  workflowClass: InteractiveWorkflowClass;
  threadId: string;
  runLegacy(): Promise<void> | void;
  admitDurable(): Promise<InteractiveTurnAcceptedResponse>;
}

export type InteractiveWorkflowRouteDecision =
  | Readonly<{
      route: 'legacy';
      reason: 'flag-disabled' | 'flag-evaluation-error';
    }>
  | Readonly<{
      route: 'durable';
      response: InteractiveTurnAcceptedResponse;
    }>;

export interface InteractiveWorkflowRouterDependencies {
  isFeatureEnabled?: FeatureFlagEvaluator;
  trackEvent?: typeof trackEvent;
}

export interface InteractiveWorkflowRouter {
  route(
    input: InteractiveWorkflowRouteInput,
  ): Promise<InteractiveWorkflowRouteDecision>;
}

function trackDecision(
  emitEvent: typeof trackEvent,
  input: InteractiveWorkflowRouteInput,
  route: InteractiveWorkflowRouteDecision['route'],
  reason: string,
): void {
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
}

export function createInteractiveWorkflowRouter(
  dependencies: InteractiveWorkflowRouterDependencies = {},
): InteractiveWorkflowRouter {
  const evaluateFlag = dependencies.isFeatureEnabled ?? isFeatureEnabled;
  const emitEvent = dependencies.trackEvent ?? trackEvent;

  return {
    async route(input): Promise<InteractiveWorkflowRouteDecision> {
      let enabled = false;
      let legacyReason:
        | 'flag-disabled'
        | 'flag-evaluation-error' = 'flag-disabled';
      try {
        enabled = await evaluateFlag(V2_TRANSPORT_FLAG, {
          userId: input.userId,
          project: input.project,
          caller: input.workflowClass,
        });
      } catch {
        legacyReason = 'flag-evaluation-error';
      }

      // Retain enabled once durable interactive transport carries production traffic.
      // @feature-flag:ai-runs-v2-transport start winner=enabled
      if (!enabled) {
        // @feature-flag:ai-runs-v2-transport disabled-start
        trackDecision(emitEvent, input, 'legacy', legacyReason);
        await input.runLegacy();
        return { route: 'legacy', reason: legacyReason };
        // @feature-flag:ai-runs-v2-transport disabled-end
      }

      // @feature-flag:ai-runs-v2-transport enabled-start
      const response = await input.admitDurable();
      trackDecision(emitEvent, input, 'durable', response.status);
      return { route: 'durable', response };
      // @feature-flag:ai-runs-v2-transport enabled-end
      // @feature-flag:ai-runs-v2-transport end
    },
  };
}

export const interactiveWorkflowRouter = createInteractiveWorkflowRouter();

export interface LegacyInteractiveWorkflowRouteInput {
  userId: string;
  project: string;
  workflowClass: InteractiveWorkflowClass;
  threadId: string;
  runId: string;
  dispatchToActor(dispatch: {
    runId: string;
    dispatchMessageId: string;
  }): Promise<void> | void;
  runInProcess(): Promise<void> | void;
}

export interface LegacyInteractiveWorkflowRouterDependencies {
  isFeatureEnabled?: FeatureFlagEvaluator;
  admissionService?: InteractiveActorAdmissionService;
  trackEvent?: typeof trackEvent;
}

export interface LegacyInteractiveWorkflowRouter {
  route(
    input: LegacyInteractiveWorkflowRouteInput,
  ): Promise<InteractiveRouteDecision>;
}

type InProcessReason = Extract<
  InteractiveRouteDecision,
  { route: 'in-process' }
>['reason'];

export function createLegacyInteractiveWorkflowRouter(
  dependencies: LegacyInteractiveWorkflowRouterDependencies = {},
): LegacyInteractiveWorkflowRouter {
  const evaluateFlag = dependencies.isFeatureEnabled ?? isFeatureEnabled;
  const admission =
    dependencies.admissionService ?? interactiveActorAdmissionService;
  const emitEvent = dependencies.trackEvent ?? trackEvent;

  const safeTrack = (
    route: InteractiveRouteDecision['route'],
    reason: string,
    input: LegacyInteractiveWorkflowRouteInput,
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
    input: LegacyInteractiveWorkflowRouteInput,
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

      // Legacy-only: reachable only from the canonical flag-off/error callback
      // (the private legacy chat send path). BR-014 / BR-017 shed-to-in-process
      // behavior lives here; durable enabled traffic never enters this router.
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
        // BR-014 (legacy-only): over-capacity / lost race sheds to in-process.
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

export const legacyInteractiveWorkflowRouter =
  createLegacyInteractiveWorkflowRouter();

export function routeInteractiveWorkflow(
  input: InteractiveWorkflowRouteInput,
): Promise<InteractiveWorkflowRouteDecision> {
  return interactiveWorkflowRouter.route(input);
}

export function routeLegacyInteractiveWorkflow(
  input: LegacyInteractiveWorkflowRouteInput,
): Promise<InteractiveRouteDecision> {
  return legacyInteractiveWorkflowRouter.route(input);
}
