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

/**
 * TBI-040 part one: start a run, let it suspend, and report its id. The process then exits.
 *
 * Nothing is returned but the id on purpose. Whatever `cold-resume` manages to do afterwards it
 * must do from storage, because the `Run` object that suspended this one dies with this process.
 */
async function probeColdSuspend(connectionString: string, schemaName: string) {
  const { Mastra } = require('@mastra/core');
  const store = await makeStore(connectionString, schemaName);
  await store.init();

  const mastra = new Mastra({ storage: store, workflows: { probe: buildWorkflow() }, logger: false });
  const workflow = mastra.getWorkflow('probe');
  const run = await workflow.createRun();
  const started = await run.start({ inputData: { subject: 'cold' } });

  if (store.close) await store.close();
  return { runId: run.runId, startStatus: started.status };
}

/**
 * TBI-040 part two: resume that run from a process that never saw it start.
 *
 * This is the demo's step 4 asked of the engine rather than of Apex. Our own traversal passes it
 * trivially because a suspended run is only ever rows; the question here is whether Mastra
 * rehydrates from `PostgresStore` or needs the original in-memory `Run`.
 */
async function probeColdResume(connectionString: string, schemaName: string, runId: string) {
  const { Mastra } = require('@mastra/core');
  const store = await makeStore(connectionString, schemaName);
  await store.init();

  const mastra = new Mastra({ storage: store, workflows: { probe: buildWorkflow() }, logger: false });
  const workflow = mastra.getWorkflow('probe');

  // Read before touching it: proves the snapshot survived the first process, separately from
  // whether resume works. If this is null the run did not persist and resume was never the issue.
  const snapshotBefore = await workflow.getWorkflowRunById(runId);

  let resumeStatus: string | null = null;
  let resumeResult: unknown = null;
  let resumeError: string | null = null;
  try {
    const run = await workflow.createRun({ runId });
    const resumed = await run.resume({ step: 'gate', resumeData: { decision: 'approved' } });
    resumeStatus = resumed.status;
    resumeResult = resumed.result ?? null;
  } catch (error) {
    resumeError = error instanceof Error ? error.message : String(error);
  }

  const snapshotAfter = await workflow.getWorkflowRunById(runId);
  if (store.close) await store.close();

  return {
    runId,
    foundInStorage: snapshotBefore !== null && snapshotBefore !== undefined,
    statusBefore: snapshotBefore?.snapshot?.status ?? snapshotBefore?.status ?? null,
    resumeStatus,
    resumeResult,
    resumeError,
    statusAfter: snapshotAfter?.snapshot?.status ?? snapshotAfter?.status ?? null,
  };
}

/**
 * TBI-041: two engine instances, one store, resume delivered to the one that did not start it.
 *
 * Two `Mastra` containers rather than two processes because the thing under test is the container's
 * own state, not the operating system's. Each gets its own store handle and its own in-memory event
 * bus, which is exactly the shape three App Service instances have — and the reason the question is
 * worth asking separately from `cold-resume`.
 */
async function probeCrossInstance(connectionString: string, schemaName: string) {
  const { Mastra } = require('@mastra/core');

  const storeA = await makeStore(connectionString, schemaName, { id: 'instance-a' });
  await storeA.init();
  // B shares the schema and inits nothing: a second App Service instance finds its tables already
  // there, and a store that only works when it created the tables itself would be a finding.
  const storeB = await makeStore(connectionString, schemaName, { id: 'instance-b', disableInit: true });

  const a = new Mastra({ storage: storeA, workflows: { probe: buildWorkflow() }, logger: false });
  const b = new Mastra({ storage: storeB, workflows: { probe: buildWorkflow() }, logger: false });

  const runA = await a.getWorkflow('probe').createRun();
  const started = await runA.start({ inputData: { subject: 'cross-instance' } });

  const workflowB = b.getWorkflow('probe');
  const seenByB = await workflowB.getWorkflowRunById(runA.runId);

  let resumeStatus: string | null = null;
  let resumeResult: unknown = null;
  let resumeError: string | null = null;
  try {
    const runB = await workflowB.createRun({ runId: runA.runId });
    const resumed = await runB.resume({ step: 'gate', resumeData: { decision: 'approved' } });
    resumeStatus = resumed.status;
    resumeResult = resumed.result ?? null;
  } catch (error) {
    resumeError = error instanceof Error ? error.message : String(error);
  }

  // Asked of A, because the instance that started the run is the one whose view going stale would
  // be the subtle failure: B finishing the run while A still believes it is suspended.
  const seenByAAfter = await a.getWorkflow('probe').getWorkflowRunById(runA.runId);

  for (const s of [storeA, storeB]) if (s.close) await s.close();

  return {
    runId: runA.runId,
    startStatus: started.status,
    visibleToOtherInstance: seenByB !== null && seenByB !== undefined,
    resumeStatus,
    resumeResult,
    resumeError,
    statusSeenByStarterAfter: seenByAAfter?.snapshot?.status ?? seenByAAfter?.status ?? null,
  };
}

/**
 * The shape of a real published graph: definition B, gate → agent → notify.
 *
 * Two suspending steps in a row is the point. The existing `buildWorkflow` has one step, so
 * TBI-040 proved a resume that *ends* a run; nothing has yet proved a resume that continues one,
 * and "the next step starts" is the entire job being handed to Mastra.
 */
const DEMO_GRAPH = {
  nodes: [
    { id: 'approve', stepType: 'approval-gate', config: { subject: 'Ship it?' } },
    { id: 'agent', stepType: 'cursor-agent', config: { skillPath: '.cursor/skills/app-knowledge/SKILL.md' } },
    { id: 'announce', stepType: 'notify', config: { title: 'Shipped' } },
  ],
  edges: [
    { from: 'approve', to: 'agent' },
    { from: 'agent', to: 'announce' },
  ],
};

/** Mirrors `canSuspend` in the Phase 0 step registry. */
const SUSPENDING_STEP_TYPES = new Set(['approval-gate', 'cursor-agent']);

const LOG_TABLE = 'apex_step_log';

/**
 * Stands in for `playbook_step_runs`: a durable, ordered record of what each step body did.
 *
 * It has to be in the database rather than in memory because the run crosses three processes, and
 * the question it answers — did any step body run twice — is only answerable from outside them.
 */
async function logStep(
  connectionString: string,
  schemaName: string,
  runId: string,
  stepId: string,
  phase: string
) {
  await query(
    connectionString,
    `INSERT INTO ${schemaName}.${LOG_TABLE} (run_id, step_id, phase) VALUES ($1, $2, $3)`,
    [runId, stepId, phase]
  );
}

async function readLog(
  connectionString: string,
  schemaName: string
): Promise<{ step_id: string; phase: string }[]> {
  return query(connectionString, `SELECT step_id, phase FROM ${schemaName}.${LOG_TABLE} ORDER BY seq`);
}

/**
 * Builds a Mastra workflow from a stored graph at run time.
 *
 * This is the translation TBI-047 has to build for real, written here at its smallest to find out
 * whether it is possible before any traversal is deleted. Mastra's workflows are authored as code
 * and ours are rows, so the whole integration rests on this being expressible.
 *
 * Each step body does what an Apex step body would: record that it began, run its adapter, then
 * either park or record completion. The adapters themselves are not called — the question here is
 * whether Mastra will *drive* bodies of this shape, not whether our adapters work, which 30 passing
 * tests already answer.
 */
function buildWorkflowFromGraph(graph: typeof DEMO_GRAPH, connectionString: string, schemaName: string) {
  const { createWorkflow, createStep } = require('@mastra/core/workflows');

  // Same ordering rule as playbookAdvanceService: start where nothing points, follow the edges.
  const hasInbound = new Set(graph.edges.map((e) => e.to));
  let cursor = graph.nodes.find((n) => !hasInbound.has(n.id)) ?? graph.nodes[0];
  const ordered: typeof graph.nodes = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    ordered.push(cursor);
    seen.add(cursor.id);
    const edge = graph.edges.find((e) => e.from === cursor!.id);
    cursor = edge ? graph.nodes.find((n) => n.id === edge.to) : undefined;
  }

  const steps = ordered.map((node) =>
    createStep({
      id: node.id,
      inputSchema: z.any(),
      resumeSchema: z.any(),
      suspendSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({ resumeData, suspend, runId }: any) => {
        const suspends = SUSPENDING_STEP_TYPES.has(node.stepType);

        if (suspends && !resumeData) {
          await logStep(connectionString, schemaName, runId ?? 'unknown', node.id, 'begin');
          return await suspend({ reason: node.stepType });
        }
        if (!suspends) {
          await logStep(connectionString, schemaName, runId ?? 'unknown', node.id, 'begin');
        }

        await logStep(connectionString, schemaName, runId ?? 'unknown', node.id, 'complete');
        return { stepId: node.id };
      },
    })
  );

  let workflow = createWorkflow({ id: 'apex-graph-wf', inputSchema: z.any(), outputSchema: z.any() });
  for (const step of steps) workflow = workflow.then(step);
  return workflow.commit();
}

async function graphEngine(connectionString: string, schemaName: string) {
  const { Mastra } = require('@mastra/core');
  const store = await makeStore(connectionString, schemaName);
  await store.init();
  const mastra = new Mastra({
    storage: store,
    workflows: { probe: buildWorkflowFromGraph(DEMO_GRAPH, connectionString, schemaName) },
    logger: false,
  });
  return { store, workflow: mastra.getWorkflow('probe') };
}

/** Spike part one: build the workflow from the graph and start it. */
async function probeGraphStart(connectionString: string, schemaName: string) {
  await query(connectionString, `CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  await query(
    connectionString,
    `CREATE TABLE IF NOT EXISTS ${schemaName}.${LOG_TABLE} (
       seq serial PRIMARY KEY, run_id text, step_id text, phase text, at timestamptz DEFAULT now())`
  );

  const { store, workflow } = await graphEngine(connectionString, schemaName);
  const run = await workflow.createRun();
  const started = await run.start({ inputData: { subject: 'spike' } });
  const log = await readLog(connectionString, schemaName);
  if (store.close) await store.close();

  return {
    runId: run.runId,
    status: started.status,
    suspendedAt: started.suspended ?? null,
    log: log.map((l) => `${l.step_id}:${l.phase}`),
  };
}

/** Spike part two: resume one suspended step from a cold process and see whether the chain moves on. */
async function probeGraphResume(
  connectionString: string,
  schemaName: string,
  runId: string,
  stepId: string
) {
  const { store, workflow } = await graphEngine(connectionString, schemaName);

  let status: string | null = null;
  let suspendedAt: unknown = null;
  let error: string | null = null;
  try {
    const run = await workflow.createRun({ runId });
    const resumed = await run.resume({ step: stepId, resumeData: { decision: 'approved' } });
    status = resumed.status;
    suspendedAt = resumed.suspended ?? null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const log = await readLog(connectionString, schemaName);
  if (store.close) await store.close();

  return { runId, resumedStep: stepId, status, suspendedAt, error, log: log.map((l) => `${l.step_id}:${l.phase}`) };
}

async function main() {
  const [mode, connectionString, schema = 'playbook_engine', extra, extra2] = process.argv.slice(2);
  const modes: Record<string, () => Promise<unknown>> = {
    'store-ddl': () => probeStoreDdl(connectionString, schema),
    'in-process': () => probeInProcess(connectionString, schema),
    pool: () => probePool(connectionString, schema),
    telemetry: () => probeTelemetry(connectionString, schema),
    'cold-suspend': () => probeColdSuspend(connectionString, schema),
    'cold-resume': () => probeColdResume(connectionString, schema, extra),
    'cross-instance': () => probeCrossInstance(connectionString, schema),
    'graph-start': () => probeGraphStart(connectionString, schema),
    'graph-resume': () => probeGraphResume(connectionString, schema, extra, extra2),
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
