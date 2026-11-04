import type { PreflightRefusal } from '../../../shared/types/buildPreflight';

export class BuildStartError extends Error {
  readonly refusals?: PreflightRefusal[];

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    refusals?: PreflightRefusal[],
  ) {
    super(message);
    this.name = 'BuildStartError';
    this.refusals = refusals;
  }
}

export class BuildStepRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildStepRefusedError';
  }
}
