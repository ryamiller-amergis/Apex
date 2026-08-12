export type BackgroundWorkflowClass =
  | 'prd'
  | 'design-doc'
  | 'validation'
  | 'test-cases';

export type WorkflowRouteDecision =
  | { route: 'worker'; workspacePath: string; runId: string }
  | { route: 'in-process'; reason: 'flag-disabled' }
  | {
      route: 'in-process';
      reason: 'materialization-unavailable';
      fallbackStarted: true;
    };
