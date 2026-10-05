/**
 * Deterministic process exit for container entrypoints.
 *
 * Setting `process.exitCode` records the status but does not end the process —
 * Node still waits for the event loop to drain, and these entrypoints hold it
 * open indefinitely via the `DefaultAzureCredential` token-refresh timer and
 * pooled HTTP sockets. A one-shot job replica that finishes its work therefore
 * stays resident until the job's `replicaTimeout`, and because KEDA treats a
 * live execution as covering a queued message, later messages wait behind it.
 */

/**
 * Grace period before the hard exit. `process.exit` discards writes still
 * queued on a piped stdout, which is how container logs are collected, so the
 * final log line needs a moment to leave the process.
 */
export const EXIT_FLUSH_GRACE_MS = 250;

export interface ExitAfterFlushOptions {
  /** Flush buffered telemetry before exiting. Failures are ignored. */
  flush?: () => Promise<void>;
  exit?: (code: number) => void;
  setExitCode?: (code: number) => void;
  schedule?: (callback: () => void, ms: number) => { unref?: () => void };
}

/**
 * Record `code`, give buffered output a moment to drain, then force the exit.
 *
 * Use on the failure path of every entrypoint. Use on the success path only for
 * one-shot jobs: a resident service resolves `main()` once it is listening, so
 * exiting there would stop it as soon as it came up.
 */
export async function exitAfterFlush(
  code: number,
  options: ExitAfterFlushOptions = {},
): Promise<void> {
  const setExitCode =
    options.setExitCode ?? ((value: number) => {
      process.exitCode = value;
    });
  const exit = options.exit ?? ((value: number) => {
    process.exit(value);
  });
  const schedule =
    options.schedule ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));

  setExitCode(code);

  if (options.flush) {
    try {
      await options.flush();
    } catch {
      // Losing the last telemetry batch is preferable to staying resident.
    }
  }

  // Unref'd so the grace timer is never itself the reason the process stays up:
  // when nothing else holds the loop, Node exits on its own carrying the code
  // set above and this callback never runs.
  const timer = schedule(() => exit(code), EXIT_FLUSH_GRACE_MS);
  timer?.unref?.();
}
