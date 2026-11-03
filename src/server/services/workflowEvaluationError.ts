import type { WorkflowEvaluationErrorCode } from '../../shared/types/workflowEvaluation';

export class WorkflowEvaluationError extends Error {
  readonly code: WorkflowEvaluationErrorCode;
  readonly fieldErrors?: Record<string, string>;

  constructor(
    code: WorkflowEvaluationErrorCode,
    message: string,
    fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'WorkflowEvaluationError';
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}
