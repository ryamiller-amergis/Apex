/**
 * loadTestRunner — FEAT-008 swappable k6 Container Apps Job runner.
 *
 * Never writes Postgres (BR-008). Mutates run state only via HTTP ingest
 * callbacks owned by loadTestRunService (FEAT-007).
 */
export { buildLoadTestArtifactKey } from './artifactKey';
export {
  mapK6ThresholdResults,
  extractObservedValue,
  summaryHasMetrics,
} from './thresholdMapper';
export {
  createContainerAppsJobRunner,
  type LoadTestRunnerDeps,
  type K6RunOptions,
  type K6RunResult,
  type IngestResponse,
} from './containerAppsJobRunner';
export {
  createHttpCallbackClient,
  type CallbackClient,
} from './callbackClient';
export {
  assertDispatchNonProd,
  createHttpAllowlistAsserter,
} from './allowlistGate';
export { createKeyVaultSecretResolver } from './secretResolver';
export { createBlobArtifactUploader } from './blobUploader';
export { createProcessK6Executor, stripExportedOptions } from './k6Executor';
