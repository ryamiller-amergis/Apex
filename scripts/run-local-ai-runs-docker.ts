/**
 * Local stand-in for the KEDA Container Apps Job.
 *
 * Admission still writes the dispatched row. This process starts one
 * `apex-ai-runs:local` container per row, the same image the deploy publishes,
 * and mounts the local workspace directory where the API wrote it.
 *
 * Requires in `.env`:
 *   AI_RUNS_DISPATCH_PUBLISHER=noop
 *   AI_RUNS_RUNNER_CALLBACK_TOKEN
 *   AI_PILOT_WORKSPACE_DIR
 *   CURSOR_API_KEY
 *   APEX_CALLBACK_URL=http://localhost:3001
 */
import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../src/server/db/drizzle';
import pool from '../src/server/db';
import { agentRuns } from '../src/server/db/schema';

const IMAGE = 'apex-ai-runs:local';
const CONTAINER_WORKSPACES = '/workspaces';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function findDispatched(): Promise<Array<{ runId: string; dispatchMessageId: string }>> {
  const rows = await db
    .select({
      runId: agentRuns.id,
      dispatchMessageId: agentRuns.dispatchMessageId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.status, 'dispatched'), eq(agentRuns.lane, 'background')))
    .orderBy(asc(agentRuns.dispatchedAt))
    .limit(10);
  return rows.flatMap((row) =>
    row.dispatchMessageId
      ? [{ runId: row.runId, dispatchMessageId: row.dispatchMessageId }]
      : [],
  );
}

async function workspaceRoot(runId: string): Promise<string> {
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, runId),
    columns: { executionSnapshot: true },
  });
  const workspaceRef = row?.executionSnapshot?.workspaceRef?.trim();
  if (!workspaceRef) throw new Error(`Run ${runId} has no workspace`);
  const configured = process.env.AI_PILOT_WORKSPACE_DIR?.trim();
  const normalized = workspaceRef.replace(/\\/g, '/').toLowerCase();
  if (configured) {
    const configuredKey = configured.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normalized === configuredKey || normalized.startsWith(`${configuredKey}/`)) {
      return configured;
    }
  }
  return path.dirname(workspaceRef);
}

function runContainer(
  dispatch: { runId: string; dispatchMessageId: string },
  workspaceDir: string,
): Promise<number> {
  const args = [
    'run', '--rm',
    '-v', `${workspaceDir}:${CONTAINER_WORKSPACES}`,
    '-e', 'AI_RUNS_ALLOW_STATIC_CALLBACK_TOKEN=true',
    '-e', 'APEX_CALLBACK_URL=http://host.docker.internal:3001',
    '-e', 'AI_RUNS_RUNNER_CALLBACK_TOKEN',
    '-e', 'CURSOR_API_KEY',
    '-e', `AI_RUNS_WORKSPACE_PATH_FROM=${workspaceDir}`,
    '-e', `AI_RUNS_WORKSPACE_PATH_TO=${CONTAINER_WORKSPACES}`,
    '-e', `AI_RUNS_DISPATCH_MESSAGE_JSON=${JSON.stringify(dispatch)}`,
    IMAGE,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  requireEnv('CURSOR_API_KEY');
  requireEnv('AI_RUNS_RUNNER_CALLBACK_TOKEN');
  requireEnv('AI_PILOT_WORKSPACE_DIR');
  const attempted = new Set<string>();
  console.log(`Watching dispatched background runs on ${IMAGE}. Ctrl+C to stop.`);
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  while (!stopping) {
    const runs = await findDispatched().catch((error: Error) => {
      console.error(`Could not read the run queue: ${error.message}`);
      return [];
    });
    for (const run of runs) {
      if (stopping || attempted.has(run.runId)) continue;
      attempted.add(run.runId);
      const workspaceDir = await workspaceRoot(run.runId);
      console.log(`→ ${run.runId}`);
      const code = await runContainer(run, workspaceDir);
      console.log(`  container exited ${code}`);
    }
    if (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error: Error) => {
      console.error(error.message);
      await pool.end().catch(() => undefined);
      process.exit(1);
    });
}
