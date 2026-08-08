/**
 * Payload-free Service Bus contract for an admitted AI run.
 *
 * Execution inputs remain in the authoritative agent_runs record. The
 * dispatchMessageId is both the persisted fence and Service Bus MessageId.
 */
export type DispatchMessage = Readonly<{
  runId: string;
  dispatchMessageId: string;
}>;

/** Observable summary returned by an admission-governor cycle. */
export type AdmissionResult = Readonly<{
  admitted: number;
  inFlight: number;
  limit: number;
}>;
