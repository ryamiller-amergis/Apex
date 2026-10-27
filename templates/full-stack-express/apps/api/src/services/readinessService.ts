/** Readiness failed. The message is fixed and no cause is attached. */
export class NotReadyError extends Error {
  constructor() {
    super('The service is not ready.');
    this.name = 'NotReadyError';
  }
}

export interface ReadinessDeps {
  /** A cheap connectivity check, such as `select 1`. */
  ping(): Promise<void>;
  /** READINESS_TIMEOUT_MS. */
  timeoutMs: number;
  /** True once shutdown has begun, so the orchestrator stops routing here. */
  isShuttingDown?: () => boolean;
}

export interface ReadinessService {
  /** Resolves when ready; throws NotReadyError otherwise. */
  check(): Promise<void>;
}

/**
 * Checks database connectivity only, not the schema: an instance deployed
 * before its migration reports ready, so migrate before deploying.
 */
export function createReadinessService(deps: ReadinessDeps): ReadinessService {
  return {
    check() {
      if (deps.isShuttingDown?.()) {
        return Promise.reject(new NotReadyError());
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new NotReadyError()), deps.timeoutMs);
        Promise.resolve()
          .then(() => deps.ping())
          .then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {
            clearTimeout(timer);
            reject(new NotReadyError());
          }
        );
      });
    },
  };
}
