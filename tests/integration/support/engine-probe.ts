/**
 * Out-of-process probe that exercises the real Mastra engine and reports what it observed as JSON.
 *
 * Why a child process. Mastra's CJS bundle calls `require()` on `@sindresorhus/slugify`, which is
 * ESM-only. Node 22 supports requiring an ESM module from CJS; Jest's module runtime does not, so
 * `require('@mastra/pg')` inside a Jest test throws "Cannot use import statement outside a module".
 * Running the engine under ts-node — the real Node runtime — sidesteps that without changing the
 * protected `jest.config.integration.js` or its transform behaviour for every other suite.
 *
 * Invoked as: ts-node engine-probe.ts <mode> <connectionString> [schema]
 * Emits one line to stdout: PROBE_RESULT <json>
 */
/* eslint-disable @typescript-eslint/no-require-imports --
   The engine is loaded with require() on purpose. A static import is hoisted and resolved by the
   transpiler, which defeats the whole reason this file exists: Mastra must be loaded by Node's own
   runtime, at call time, so that its require() of an ESM-only dependency succeeds. The telemetry
   probe additionally depends on the load happening after the kill-switch env var is set. */
import { z } from 'zod';
import pg from 'pg';
import express from 'express';
import { withEgressRecorder, EgressCall } from './egress-recorder';

const RESULT_PREFIX = 'PROBE_RESULT ';

async function query(connectionString: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const tableSnapshot = (connectionString: string) =>
  query(
    connectionString,
    `SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog','information_schema')
     ORDER BY table_schema, table_name`
  );

/** A one-step approval-gate workflow — the smallest graph that exercises suspend and resume. */
function buildWorkflow() {
  // Required rather than imported so the ESM-from-CJS load happens under Node, not the transpiler.
  const { createWorkflow, createStep } = require('@mastra/core/workflows');
  const step = createStep({
    id: 'gate',
    inputSchema: z.object({ subject: z.string() }),
    resumeSchema: z.object({ decision: z.string() }),
    suspendSchema: z.object({ reason: z.string() }),
    outputSchema: z.object({ decision: z.string() }),
    execute: async ({ inputData, resumeData, suspend }: any) =>
      resumeData ? { decision: resumeData.decision } : await suspend({ reason: `for ${inputData.subject}` }),
  });
  return createWorkflow({
    id: 'probe-wf',
    inputSchema: z.object({ subject: z.string() }),
    outputSchema: z.object({ decision: z.string() }),
  })
    .then(step)
    .commit();
}

async function makeStore(connectionString: string, schemaName: string, extra: Record<string, unknown> = {}) {
  const { PostgresStore } = require('@mastra/pg');
  await query(connectionString, `CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  const store = new PostgresStore({ id: `probe-${schemaName}`, connectionString, schemaName, ...extra });
  return store;
}

/** TBI-001: what DDL does the store issue, and where does it land? */
async function probeStoreDdl(connectionString: string, schemaName: string) {
  const before = await tableSnapshot(connectionString);
  const store = await makeStore(connectionString, schemaName);
  await store.init();
  const after = await tableSnapshot(connectionString);
  const added = after.filter(
    (a) => !before.some((b) => b.table_schema === a.table_schema && b.table_name === a.table_name)
  );
  if (store.close) await store.close();

  // A second store with init suppressed must create nothing.
  const suppressedSchema = `${schemaName}_noinit`;
  const beforeSuppressed = await tableSnapshot(connectionString);
  const suppressed = await makeStore(connectionString, suppressedSchema, { disableInit: true });
  const afterSuppressed = await tableSnapshot(connectionString);
  if (suppressed.close) await suppressed.close();

  return {
    createdTables: added.map((t) => `${t.table_schema}.${t.table_name}`),
    createdInPublic: added.filter((t) => t.table_schema === 'public').length,
    apexTablesInPublic: before.filter((t) => t.table_schema === 'public').length,
    disableInitCreated:
      afterSuppressed.filter((t) => t.table_schema === suppressedSchema).length -
      beforeSuppressed.filter((t) => t.table_schema === suppressedSchema).length,
  };
}

/** TBI-002: drive the whole lifecycle with nothing mounted. */
async function probeInProcess(connectionString: string, schemaName: string) {
  const { Mastra } = require('@mastra/core');
  const store = await makeStore(connectionString, schemaName);
  await store.init();

  const app = express();
  // Express 4 creates `_router` lazily; the `app.router` getter throws a 3.x deprecation error.
  const layers = () => ((app as any)._router?.stack?.length ?? 0);
  const layersBefore = layers();

  const mastra = new Mastra({ storage: store, workflows: { probe: buildWorkflow() }, logger: false });
  const workflow = mastra.getWorkflow('probe');
  const newRun = () => (workflow.createRunAsync ? workflow.createRunAsync() : Promise.resolve(workflow.createRun()));

  const run = await newRun();
  const started = await run.start({ inputData: { subject: 'probe' } });
  const resumed = await run.resume({ step: 'gate', resumeData: { decision: 'approved' } });

  const cancelled = await newRun();
  await cancelled.start({ inputData: { subject: 'cancel-me' } });
  await cancelled.cancel();
  const cancelledRecord = await workflow.getWorkflowRunById(cancelled.runId);

  if (store.close) await store.close();
  return {
    startStatus: started.status,
    resumeStatus: resumed.status,
    resumeResult: resumed.result ?? null,
    cancelStatus: cancelledRecord?.snapshot?.status ?? cancelledRecord?.status ?? null,
    expressLayersBefore: layersBefore,
    expressLayersAfter: layers(),
  };
}

/** TBI-003: does it take our pool, and how big is the one it builds itself? */
async function probePool(connectionString: string, schemaName: string) {
  const injectedPool = new pg.Pool({ connectionString, max: 5 });
  const injected = await makeStore(`${connectionString}`, `${schemaName}_inject`, { pool: injectedPool });
  await injected.init();
  const acceptsInjected = injected.pool === injectedPool;

  const owned = await makeStore(connectionString, `${schemaName}_own`);
  await owned.init();
  const defaultMax = owned.pool?.options?.max ?? null;

  const capped = await makeStore(connectionString, `${schemaName}_capped`, { max: 3 });
  await capped.init();
  const explicitMax = capped.pool?.options?.max ?? null;

  for (const s of [injected, owned, capped]) if (s.close) await s.close();
  await injectedPool.end().catch(() => undefined);
  return { acceptsInjectedPool: acceptsInjected, defaultPoolMax: defaultMax, explicitMaxHonoured: explicitMax };
}

/** TBI-005: run the workflow with the egress recorder active and report every outbound attempt. */
async function probeTelemetry(connectionString: string, schemaName: string) {
  const { Mastra } = require('@mastra/core');
  const observed = await withEgressRecorder(async () => {
    const store = await makeStore(connectionString, schemaName);
    await store.init();
    const mastra = new Mastra({ storage: store, workflows: { probe: buildWorkflow() }, logger: false });
    const workflow = mastra.getWorkflow('probe');
    const run = await (workflow.createRunAsync ? workflow.createRunAsync() : workflow.createRun());
    await run.start({ inputData: { subject: 'telemetry' } });
    await run.resume({ step: 'gate', resumeData: { decision: 'approved' } });
    if (store.close) await store.close();
  });

  const describe = (calls: EgressCall[]) => [...new Set(calls.map((c) => `${c.layer} ${c.host}${c.port ? ':' + c.port : ''}`))];
  let telemetryEnabled: boolean | null = null;
  try {
    telemetryEnabled = require('@mastra/core/telemetry').isTelemetryEnabled?.() ?? null;
  } catch {
    /* helper is not exported in every build — the recorder is the real evidence. */
  }

  return {
    killSwitchEnvValue: process.env.MASTRA_TELEMETRY_DISABLED ?? null,
    isTelemetryEnabled: telemetryEnabled,
    totalCalls: observed.calls.length,
    externalCalls: observed.external.length,
    externalDestinations: describe(observed.external),
    allDestinations: describe(observed.calls),
  };
}

async function main() {
  const [mode, connectionString, schema = 'playbook_engine'] = process.argv.slice(2);
  const modes: Record<string, () => Promise<unknown>> = {
    'store-ddl': () => probeStoreDdl(connectionString, schema),
    'in-process': () => probeInProcess(connectionString, schema),
    pool: () => probePool(connectionString, schema),
    telemetry: () => probeTelemetry(connectionString, schema),
  };
  const run = modes[mode];
  if (!run) throw new Error(`unknown probe mode "${mode}" — expected one of ${Object.keys(modes).join(', ')}`);
  process.stdout.write(RESULT_PREFIX + JSON.stringify(await run()) + '\n');
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`probe failed: ${error?.stack ?? error}\n`);
    process.exit(1);
  }
);
