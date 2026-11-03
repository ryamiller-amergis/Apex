import type { ProblemDetails } from '@project-scope/contracts';

export type ApiErrorKind =
  'unauthenticated' | 'problem' | 'invalid-response' | 'network';

/**
 * The one error the web client throws for `/api/v1/me`. The message is the
 * kind, never a Problem Details field, so a log cannot repeat identity data.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly problem: ProblemDetails | null;

  constructor(options: {
    kind: ApiErrorKind;
    status: number | null;
    problem: ProblemDetails | null;
  }) {
    super(options.kind);
    this.name = 'ApiError';
    this.kind = options.kind;
    this.status = options.status;
    this.problem = options.problem;
  }

  get isUnauthenticated(): boolean {
    return this.kind === 'unauthenticated';
  }
}
