/**
 * The configuration Apex activates on the engine.
 *
 * This is deliberately a plain object built by a pure function rather than something assembled
 * while starting the engine. Two of this Feature's guarantees — that no commercially licensed
 * feature is switched on, and that telemetry is off — are only checkable if the configuration can
 * be inspected without running anything.
 *
 * Nothing here imports an engine package. The wrapper is *permitted* to (the lint boundary carves
 * this directory out), but Phase 0 has nothing to orchestrate yet, so importing one would ship a
 * dependency that never executes.
 */

/** Where the engine's own tables live. A migration owns this schema; the engine never creates it. */
export const ENGINE_SCHEMA = 'playbook_engine';

/**
 * Connections the engine's store may open, checked against the database budget by the FEAT-001
 * conformance suite. The engine defaults to 20; Apex declares a smaller number because the store is
 * an execution cache rather than the system of record.
 */
export const ENGINE_POOL_MAX = 5;

export interface PlaybookEngineConfig {
  /** Postgres schema the engine store is confined to. */
  schemaName: string;
  /** Table creation is a migration's job, so the engine must not do it at startup. */
  disableInit: boolean;
  pool: { max: number };
  telemetry: { enabled: boolean };
}

/**
 * Builds the configuration exactly as the engine would receive it.
 *
 * `telemetry.enabled: false` is the in-configuration half of the kill switch; the environment
 * variable `MASTRA_TELEMETRY_DISABLED` is the other half. FEAT-001 observed no outbound call from
 * the workflow path, which means neither half has been exercised in anger — so both are set rather
 * than picking whichever seems likelier to be the one that matters.
 */
export function buildEngineConfig(): PlaybookEngineConfig {
  return {
    schemaName: ENGINE_SCHEMA,
    disableInit: true,
    pool: { max: ENGINE_POOL_MAX },
    telemetry: { enabled: false },
  };
}
