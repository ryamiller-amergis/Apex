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
  /** Whether the engine is forbidden from creating its own tables at startup. */
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
/*
 * `disableInit: false` corrects a Phase 0 assumption that only became testable once the engine ran.
 *
 * Phase 0 recorded the pattern as "migration-created schema plus `disableInit: true`", but the
 * migration creates the *schema* and the role — not the engine's 43 tables — and it grants
 * `USAGE, CREATE ON SCHEMA playbook_engine` to the engine role, which would be pointless if the
 * engine were never to create anything. Suppression with no tables behind it is simply a store that
 * cannot read or write.
 *
 * What the migration buys is confinement, not the absence of DDL. The ADR's phase-0 condition is
 * that no table lands in `public` under any configuration, and that still holds: the store is bound
 * to `schemaName` and the conformance suite asserts it (INV-01). Writing the table shapes into a
 * migration instead would couple an Apex migration to Mastra's internal schema and break on the
 * next version bump — the coupling the verification record warns against.
 */
export function buildEngineConfig(): PlaybookEngineConfig {
  return {
    schemaName: ENGINE_SCHEMA,
    disableInit: false,
    pool: { max: ENGINE_POOL_MAX },
    telemetry: { enabled: false },
  };
}
