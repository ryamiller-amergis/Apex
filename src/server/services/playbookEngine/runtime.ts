/**
 * The engine itself: loading it, translating an Apex graph into one of its workflows, and driving a
 * run through it.
 *
 * This file and `index.ts` are the only places Mastra may be named. Everything outside this
 * directory speaks Apex vocabulary, which is what keeps replacing the engine a change to one
 * directory rather than to every caller.
 *
 * The division of labour is the one the PRD sets out. Mastra decides **which step runs next** and
 * holds the mechanics of parking and waking a run. Apex writes every row: a step that Mastra drives
 * still begins, completes and fails through `playbookSteps`, because the status view, the
 * reconciliation sweep and the permission re-check read Apex's tables and nothing else.
 */
import { z } from 'zod';
import { buildEngineConfig } from './engineConfig';
import {
  beginStepRun,
  completeStepRunIfOpen,
  executeStep,
  failStepRun,
  failStepRunForHuman,
  PlaybookRunTerminatedError,
} from '../playbookSteps';
import {
  assertStepGateSatisfied,
  PlaybookGuardViolationError,
} from '../playbookGuardService';
import { isBranchStepType } from '../playbookSteps/registry';
import type { PlaybookGraph, PlaybookGraphNode } from '../../../shared/types/playbook';

/**
 * Loads an engine package through the real module loader.
 *
 * Mastra ships CommonJS that reaches an ESM-only dependency (`@sindresorhus/slugify`). Node 22
 * permits that; Jest's module runtime does not, and it rewrites a literal `import()` into its own
 * `require` before the code ever runs.
 *
 * A function built by `new Function` is compiled by V8 at run time and never passes through a
 * transform, so the `import()` inside it is the genuine one in both environments. Under Jest this
 * additionally needs `--experimental-vm-modules`, which `npm run test:integration` sets.
 *
 * Keep this as the single way in. A plain `import`/`require` of Mastra anywhere in this directory
 * works in production and fails every integration suite, which is a slow and confusing way to find
 * out.
 */
const realImport = new Function(
  'specifier',
  /*
   * The trailing comment is not decoration. V8 caches compiled sources, and the cached entry
   * carries the dynamic-import callback of the realm that first compiled it. Under Jest that
   * realm is a test file's VM context, which is torn down when the file ends, so the second file
   * to compile this exact source inherits a callback into a dead context and every engine call in
   * it fails with "Test environment has been torn down" — a message that names neither Mastra nor
   * the import. Making the source unique per module evaluation gives each context its own
   * compilation. In production the module is evaluated once and this is a no-op.
   */
  `return import(specifier); // ${Date.now()}.${Math.random()}`
) as (specifier: string) => Promise<Record<string, unknown>>;

interface EngineModules {
  createWorkflow: (...args: unknown[]) => any;
  createStep: (...args: unknown[]) => any;
  Mastra: new (...args: unknown[]) => any;
  PostgresStore: new (...args: unknown[]) => any;
}

let modules: EngineModules | null = null;

/**
 * The resolved modules are cached, never the promise that produced them.
 *
 * That distinction is invisible in production and decisive under Jest. A cache can outlive the
 * VM context that filled it, and awaiting a promise built in a context that has since been torn
 * down throws "Test environment has been torn down" from somewhere that looks nothing like the
 * cause. Awaiting a plain value schedules its continuation in whichever context is running now,
 * so a cache of values is safe to cross that boundary and a cache of promises is not.
 *
 * Two callers racing here would import twice, which costs nothing: Node's module registry returns
 * the same objects, and the second assignment is identical to the first.
 */
async function loadModules(): Promise<EngineModules> {
  if (modules) return modules;

  /*
   * Sequential, not `Promise.all`. These three share a dependency graph, and importing them
   * concurrently lets Jest's ESM registry start linking a module that another import is already
   * part-way through, which surfaces as "request for './classic/external.js' is from a module not
   * been linked". Awaiting each in turn costs a few hundred milliseconds once per process.
   */
  const workflows = await realImport('@mastra/core/workflows');
  const core = await realImport('@mastra/core');
  const pg = await realImport('@mastra/pg');

  modules = {
    createWorkflow: workflows.createWorkflow as EngineModules['createWorkflow'],
    createStep: workflows.createStep as EngineModules['createStep'],
    Mastra: core.Mastra as EngineModules['Mastra'],
    PostgresStore: pg.PostgresStore as EngineModules['PostgresStore'],
  };
  return modules;
}

/**
 * One store for the process, because a store is a connection pool.
 *
 * `ENGINE_POOL_MAX` is declared against the database's connection budget and checked by the
 * conformance suite; building a store per operation would multiply that number by the request rate
 * and make the declared budget a fiction.
 */
let store: any = null;

/** Cached as a value rather than a promise, for the reason given on `loadModules`. */
async function loadStore(): Promise<any> {
  if (store) return store;

  const { PostgresStore } = await loadModules();
  const config = buildEngineConfig();

  const built = new PostgresStore({
    id: 'apex-playbook-engine',
    connectionString: process.env.DATABASE_URL,
    schemaName: config.schemaName,
    max: config.pool.max,
    disableInit: config.disableInit,
  });

  /*
   * The migration creates the schema and grants CREATE inside it; the tables are the engine's own
   * and it makes them here. Confinement is what the migration buys — not the absence of DDL — so
   * this creates 43 tables inside `playbook_engine` and none anywhere else.
   */
  await built.init();
  store = built;
  return store;
}

/**
 * Closes the engine's connection pool. Called when a process is shutting down, and by integration
 * suites before they drop their scratch database — an open pool holds sessions against it, and
 * `DROP DATABASE` will not run while anything is connected.
 *
 * The loaded modules are deliberately left alone. They are process-wide and hold nothing open.
 */
export async function closeEngineStore(): Promise<void> {
  const open = store;
  store = null;
  if (open?.close) await open.close();
}

/**
 * Orders a graph's nodes into the chain Mastra will execute.
 *
 * Start where nothing points and follow the edges, which is the same rule the publish-time guards
 * enforce when they cap fan-out at one. A node reachable only through a cycle is dropped rather
 * than looped, because the guards refuse cycles at publish time and a cycle arriving here belongs
 * to a version published before that guard existed.
 */
function orderedNodes(graph: PlaybookGraph): PlaybookGraphNode[] {
  if (graph.nodes.length === 0) return [];

  const hasInbound = new Set(graph.edges.map((edge) => edge.to));
  let node: PlaybookGraphNode | undefined =
    graph.nodes.find((n) => !hasInbound.has(n.id)) ?? graph.nodes[0];

  const ordered: PlaybookGraphNode[] = [];
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    ordered.push(node);
    seen.add(node.id);
    const edge = graph.edges.find((e) => e.from === node!.id);
    node = edge ? graph.nodes.find((n) => n.id === edge.to) : undefined;
  }
  return ordered;
}

export interface EngineRunContext {
  runId: string;
  project: string;
  initiatorUserId: string;
}

/**
 * Translates a stored graph into a Mastra workflow whose step bodies are Apex's.
 *
 * Mastra's workflows are authored as code and Apex's are rows, so this is the join between the two
 * and the reason the integration is possible at all. It is built per call rather than registered
 * once because the graph differs per pinned version, and a run must follow the version it started
 * on for its whole life.
 *
 * Schemas are deliberately permissive. Step payloads are Apex's `config` blobs, already validated
 * against the step registry at publish time; re-describing them in zod here would put the same
 * contract in two places and make adding a step type a change to both.
 */
export function translate(
  graph: PlaybookGraph,
  context: EngineRunContext,
  modules: EngineModules
) {
  const { createWorkflow, createStep } = modules;

  const stepById = new Map(graph.nodes.map((node) => [
    node.id,
    createStep({
      id: node.id,
      inputSchema: z.any(),
      resumeSchema: z.any(),
      suspendSchema: z.any(),
      outputSchema: z.any(),
      execute: async ({ resumeData, suspend }: any) => {
        /*
         * Being resumed. The step's Apex row was already moved to `completed` by whatever resolved
         * it — `submitApprovalDecision` for a gate, the terminal-event listener for an agent run —
         * and those are the single place a suspended step completes. Writing it again here would
         * put that transition in two places and make one of them wrong eventually.
         */
        if (resumeData) return { stepId: node.id };
        const stepRun = await beginStepRun({
          runId: context.runId,
          stepId: node.id,
          stepType: node.stepType,
          inputInline: node.config ?? {},
        });

        try {
          // Resolve through the current registry at the last boundary before adapter dispatch.
          // A pinned version may predate a step type's reclassification to `leaves-apex`.
          assertStepGateSatisfied(graph, node.id);
        } catch (error) {
          if (
            error instanceof PlaybookGuardViolationError &&
            error.violation.kind === 'ungated-leaves-apex'
          ) {
            await failStepRunForHuman({
              stepRunId: stepRun.id,
              reason: error.message,
            });
            return suspend({ stepId: node.id });
          }

          await failStepRun({
            stepRunId: stepRun.id,
            reason: error instanceof Error ? error.message : `Step ${node.id} failed`,
          });
          throw error;
        }

        let outcome;
        try {
          outcome = await executeStep({
            runId: context.runId,
            stepRunId: stepRun.id,
            stepId: node.id,
            stepType: node.stepType,
            project: context.project,
            initiatorUserId: context.initiatorUserId,
            config: node.config ?? {},
            graph,
          });
        } catch (error) {
          if (error instanceof PlaybookRunTerminatedError) throw error;
          await failStepRun({
            stepRunId: stepRun.id,
            reason: error instanceof Error ? error.message : `Step ${node.id} failed`,
          });
          // Rethrown so Mastra stops the chain too. Apex's run row is failed by the caller.
          throw error;
        }

        /*
         * The adapter has already written its own suspension row, including the deadline and the
         * agent run id. Mastra is told to park so that its notion of position matches Apex's.
         */
        if (outcome.kind === 'suspended') {
          const s = await suspend({ stepId: node.id });
          return s;
        }

        // Conditional because adapters own their status writes; this is the backstop for one that
        // reports completion without having recorded it.
        await completeStepRunIfOpen({ stepRunId: stepRun.id, output: outcome.output });
        if (outcome.output?.outcome === 'stale') {
          throw new PlaybookRunTerminatedError();
        }
        return { stepId: node.id, ...(outcome.output ?? {}) };
      },
    }),
  ]));

  let workflow = createWorkflow({
    id: `apex-playbook-${context.runId}`,
    inputSchema: z.any(),
    outputSchema: z.any(),
  });
  const ordered = orderedNodes(graph);
  for (const node of ordered) {
    workflow = workflow.then(stepById.get(node.id));
    const outbound = graph.edges.filter((edge) => edge.from === node.id);
    if (isBranchStepType(node.stepType) && outbound.length > 0) {
      workflow = workflow.branch(outbound.map((edge) => [
        async ({ inputData }: { inputData: Record<string, unknown> }) =>
          inputData.continuation === edge.condition,
        stepById.get(edge.to),
      ]));
      break;
    }
  }
  return workflow.commit();
}

/** Where driving a run stopped. Apex vocabulary; the engine's own statuses do not leave this file. */
export type EngineEnd = 'suspended' | 'completed' | 'failed';

export interface EngineOutcome {
  endedAs: EngineEnd;
  /** Set when `endedAs` is `suspended`. */
  suspendedStepId?: string;
  /** Set when `endedAs` is `failed`, so a caller can rethrow what actually went wrong. */
  error?: unknown;
}

/**
 * Builds the container and hands back the one workflow this run needs.
 *
 * **The wrapper object is load-bearing — do not return the workflow directly.** A Mastra workflow
 * has a `then` method, because `.then(step)` is how steps are chained onto it. That makes it a
 * thenable, so `await`ing one hands `resolve` and `reject` to the builder as though they were
 * steps: the workflow quietly grows two junk steps and the promise never settles. The symptom is
 * an engine call that hangs forever with no error and no step ever executing, which is an
 * expensive thing to diagnose twice.
 */
async function workflowFor(
  graph: PlaybookGraph,
  context: EngineRunContext
): Promise<{ workflow: any }> {
  const modules = await loadModules();
  const store = await loadStore();

  const mastra = new modules.Mastra({
    storage: store,
    workflows: { run: translate(graph, context, modules) },
    logger: false,
  });
  return { workflow: mastra.getWorkflow('run') };
}

/** Reads the parked step out of an engine result, whatever shape it reports it in. */
function suspendedStepFrom(result: any): string | undefined {
  const suspended = result?.suspended;
  if (!Array.isArray(suspended) || suspended.length === 0) return undefined;
  const first = suspended[0];
  return Array.isArray(first) ? first[first.length - 1] : first;
}

function endFrom(result: any): EngineOutcome {
  if (result?.status === 'suspended') {
    return { endedAs: 'suspended', suspendedStepId: suspendedStepFrom(result) };
  }
  if (result?.status === 'success') return { endedAs: 'completed' };
  return { endedAs: 'failed', error: result?.error ?? new Error(`Run ended as "${result?.status}"`) };
}

/**
 * Drives a run from its first step until one parks, one fails, or the graph runs out.
 *
 * The engine's run id is Apex's run id. Apex owns run identity, and sharing the id is what lets any
 * process resume a run knowing nothing but the row — proven across processes and across instances
 * before this was written.
 */
export async function startRunOnEngine(
  graph: PlaybookGraph,
  context: EngineRunContext
): Promise<EngineOutcome> {
  const { workflow } = await workflowFor(graph, context);
  const run = await workflow.createRun({ runId: context.runId });

  try {
    return endFrom(await run.start({ inputData: {} }));
  } catch (error) {
    if (error instanceof Error && error.name === 'PlaybookRunTerminatedError') {
      return { endedAs: 'completed' };
    }
    return { endedAs: 'failed', error };
  }
}

/**
 * Continues a run whose step has been resolved outside the engine.
 *
 * Every suspension Apex creates is woken by something Apex owns — an approval decision, a terminal
 * agent-run event, or the sweep — so the engine is never asked to discover that a step finished. It
 * is handed the step id and told to carry on. That is also why no distributed event bus is needed
 * for multi-instance deployment: delivery is `pg_notify`'s job, not the engine's.
 */
export async function resumeRunOnEngine(
  graph: PlaybookGraph,
  context: EngineRunContext,
  stepId: string
): Promise<EngineOutcome> {
  const { workflow } = await workflowFor(graph, context);
  const run = await workflow.createRun({ runId: context.runId });

  try {
    return endFrom(await run.resume({ step: stepId, resumeData: { stepId } }));
  } catch (error) {
    if (error instanceof Error && error.name === 'PlaybookRunTerminatedError') {
      return { endedAs: 'completed' };
    }
    return { endedAs: 'failed', error };
  }
}

/**
 * Re-executes one existing retryable Apex step row, then resumes traversal from that node.
 *
 * This narrow operation exists because Mastra's public restart operation restarts a workflow, not
 * one Apex-owned failed row. The same runtime gate and adapter dispatch used by normal traversal
 * run again here; no engine type escapes this wrapper.
 */
export async function retryStepRunOnEngine(
  graph: PlaybookGraph,
  context: EngineRunContext,
  stepRunId: string,
  stepId: string
): Promise<EngineOutcome> {
  const node = graph.nodes.find((candidate) => candidate.id === stepId);
  if (!node) {
    return { endedAs: 'failed', error: new Error(`No graph node "${stepId}" to retry.`) };
  }

  try {
    // BR-013: this is deliberately re-evaluated on every attempt.
    assertStepGateSatisfied(graph, node.id);

    const outcome = await executeStep({
      runId: context.runId,
      stepRunId,
      stepId: node.id,
      stepType: node.stepType,
      project: context.project,
      initiatorUserId: context.initiatorUserId,
      config: node.config ?? {},
      graph,
    });

    if (outcome.kind === 'suspended') {
      return { endedAs: 'suspended', suspendedStepId: node.id };
    }

    await completeStepRunIfOpen({ stepRunId, output: outcome.output });
    if (outcome.output?.outcome === 'stale') {
      throw new PlaybookRunTerminatedError();
    }
    return resumeRunOnEngine(graph, context, node.id);
  } catch (error) {
    if (error instanceof Error && error.name === 'PlaybookRunTerminatedError') {
      return { endedAs: 'completed' };
    }
    return { endedAs: 'failed', error };
  }
}

/** Terminates a run in the engine. Apex's own row is the caller's business. */
export async function cancelRunOnEngine(
  graph: PlaybookGraph,
  context: EngineRunContext
): Promise<void> {
  const { workflow } = await workflowFor(graph, context);
  const run = await workflow.createRun({ runId: context.runId });
  await run.cancel();
}
