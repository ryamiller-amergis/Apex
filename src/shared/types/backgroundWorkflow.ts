/**
 * The kinds of background work Apex knows how to run.
 *
 * `playbook-step` is vocabulary rather than enforcement: `ExecutionSnapshot.workflowClass` is a
 * plain `string`, so `enqueue` would accept the value with or without this member. It is here
 * because a Playbook agent step genuinely is one of these kinds, and because the two checkout-
 * strategy sets in `backgroundWorkflowRouter` are typed by this union.
 *
 * Note for anyone routing a Playbook step through that router later: `playbook-step` is in neither
 * `SHARED_READ_WORKFLOW_CLASSES` nor `SCRATCH_ONLY_WORKFLOW_CLASSES`, which means full
 * materialization. That is untested for Playbooks and almost certainly not what you want — the
 * `cursor-agent` adapter calls `agentRunLifecycleService.enqueue` directly and never reaches the
 * router, because the router falls back to running in-process when `ai-runs-background` is off, and
 * an in-process agent turn is the process-resident waiter the engine was adopted to eliminate.
 */
export type BackgroundWorkflowClass =
  | 'prd'
  | 'design-doc'
  | 'validation'
  | 'test-cases'
  | 'walkthrough-smart-tagging'
  | 'playbook-step';

export type WorkflowRouteDecision =
  | { route: 'worker'; workspacePath: string; runId: string }
  | { route: 'in-process'; reason: 'flag-disabled' }
  | {
      route: 'in-process';
      reason: 'materialization-unavailable';
      fallbackStarted: true;
    };
