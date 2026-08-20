import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads, rfpRequests } from '../db/schema';
import {
  parseProductIntakeEvaluationOutput,
  PRODUCT_INTAKE_EVALUATION_OUTPUT_FILE,
} from '../../shared/types/rfpIntake';
import {
  hydrateThread,
  isThreadIdle,
  createThread as createChatThread,
} from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import {
  APEX_PROJECT,
  getRequestById,
  markEvaluationFailedIfEvaluating,
  persistSuccessfulEvaluation,
  setEvaluationThread,
} from './rfpIntakeService';

const WATCHER_INTERVAL_MS = 5_000;
/** ~10 minute hard ceiling at a 5s poll, independent of the 60s P95 target. */
const WATCHER_MAX_ATTEMPTS = 120;

const activeWatchers = new Map<string, ReturnType<typeof setInterval>>();

export function stopWatcher(rfpId: string): void {
  const handle = activeWatchers.get(rfpId);
  if (handle !== undefined) {
    clearInterval(handle);
    activeWatchers.delete(rfpId);
    console.log(`[rfpEvaluation] Cancelled watcher — rfpId=${rfpId}`);
  }
}

export function isWatcherActive(rfpId: string): boolean {
  return activeWatchers.has(rfpId);
}

function resolveOutputPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.ai-pilot', 'output', PRODUCT_INTAKE_EVALUATION_OUTPUT_FILE);
}

function readOutputFromWorkspace(workspaceDir: string): string | null {
  const outputPath = resolveOutputPath(workspaceDir);
  if (!fs.existsSync(outputPath)) return null;
  try {
    return fs.readFileSync(outputPath, 'utf-8');
  } catch {
    return null;
  }
}

async function getWorkspaceDir(threadId: string): Promise<string | null> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { workspaceDir: true },
  });
  return row?.workspaceDir ?? null;
}

async function cleanupWorkspace(threadId: string): Promise<void> {
  try {
    const workspaceDir = await getWorkspaceDir(threadId);
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  } catch { /* non-fatal */ }
}

function buildIntakeContext(request: NonNullable<Awaited<ReturnType<typeof getRequestById>>>): string {
  return JSON.stringify({
    title: request.title,
    stakeholder: request.stakeholder,
    request: request.request,
    problem: request.problem,
    audience: request.audience,
    dataSensitivity: request.dataSensitivity,
    existingSolution: request.existingSolution,
    advantage: request.advantage,
    constraints: request.constraints,
    requestType: request.requestType,
    existingSystemStack: request.existingSystemStack,
    reviewerDecision: request.reviewerDecision
      ? {
          verdict: request.reviewerDecision.verdict,
          rationale: request.reviewerDecision.rationale,
          constraintsToHonor: request.constraints,
        }
      : null,
  }, null, 2);
}

export async function autoStartEvaluation(rfpId: string): Promise<void> {
  const request = await getRequestById(rfpId);
  if (!request) {
    console.warn(`[rfpEvaluation] Request not found — rfpId=${rfpId}`);
    return;
  }

  const project = request.sourceProject || APEX_PROJECT;
  let skillConfig = await resolveSkillConfig({ project });
  if (!skillConfig && project !== APEX_PROJECT) {
    skillConfig = await resolveSkillConfig({ project: APEX_PROJECT });
  }
  if (!skillConfig) {
    await markEvaluationFailedIfEvaluating(rfpId);
    console.warn(`[rfpEvaluation] No skill config for project=${project} — marking failed`);
    return;
  }

  const skillPath = skillConfig.productIntakeEvaluationSkillPath;
  if (!skillPath) {
    await markEvaluationFailedIfEvaluating(rfpId);
    console.warn('[rfpEvaluation] No productIntakeEvaluationSkillPath configured — marking failed');
    return;
  }

  const globalModel = await getDefaultModel();
  const model = skillConfig.productIntakeEvaluationModel ?? skillConfig.defaultModel ?? globalModel;
  const freeformContext = buildIntakeContext(request);

  const thread = await createChatThread('system', {
    project: APEX_PROJECT,
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch ?? 'main',
    skillProvider: skillConfig.skillProvider ?? 'ado',
    skillPath,
    freeformContext,
    model,
  });

  stopWatcher(rfpId);
  await setEvaluationThread(rfpId, thread.id);
  startWatcher(rfpId, thread.id);
}

export function startWatcher(rfpId: string, threadId: string): void {
  stopWatcher(rfpId);
  let attempts = 0;
  let workspaceDir: string | null = null;

  console.log(`[rfpEvaluation] Started watcher — rfpId=${rfpId} threadId=${threadId}`);

  const interval = setInterval(async () => {
    attempts += 1;

    if (attempts > WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activeWatchers.delete(rfpId);
      console.warn(`[rfpEvaluation] Timed out — rfpId=${rfpId}`);
      const marked = await markEvaluationFailedIfEvaluating(rfpId);
      if (!marked) {
        console.log(`[rfpEvaluation] Timeout ignored — no longer evaluating (rfpId=${rfpId})`);
      }
      return;
    }

    if (!workspaceDir) {
      workspaceDir = await getWorkspaceDir(threadId);
      if (!workspaceDir) return;
    }

    const raw = readOutputFromWorkspace(workspaceDir);

    if (!raw) {
      if (isThreadIdle(threadId)) {
        clearInterval(interval);
        activeWatchers.delete(rfpId);
        console.warn(`[rfpEvaluation] Agent completed without output — rfpId=${rfpId}`);
        const marked = await markEvaluationFailedIfEvaluating(rfpId);
        if (!marked) {
          console.log(`[rfpEvaluation] Without-output ignored — no longer evaluating (rfpId=${rfpId})`);
        }
      }
      return;
    }

    clearInterval(interval);
    activeWatchers.delete(rfpId);

    try {
      const currentRequest = await db.query.rfpRequests.findFirst({
        where: eq(rfpRequests.id, rfpId),
        columns: { aiThreadId: true },
      });
      if (currentRequest?.aiThreadId !== threadId) {
        console.log(`[rfpEvaluation] Discarded stale result — thread ${threadId} no longer active (rfpId=${rfpId})`);
        await cleanupWorkspace(threadId);
        return;
      }

      const parsedJson = JSON.parse(raw) as unknown;
      const output = parseProductIntakeEvaluationOutput(parsedJson);
      if (!output) {
        console.error(`[rfpEvaluation] Malformed output (rfpId=${rfpId})`);
        const marked = await markEvaluationFailedIfEvaluating(rfpId);
        if (!marked) {
          console.log(`[rfpEvaluation] Parse-fail ignored — no longer evaluating (rfpId=${rfpId})`);
        }
        return;
      }

      await persistSuccessfulEvaluation(rfpId, output);
      console.log(`[rfpEvaluation] Evaluation synced — verdict=${output.verdict} (rfpId=${rfpId})`);
      await cleanupWorkspace(threadId);
    } catch (err) {
      console.error(`[rfpEvaluation] Failed to parse/sync output (rfpId=${rfpId})`, err);
      const marked = await markEvaluationFailedIfEvaluating(rfpId);
      if (!marked) {
        console.log(`[rfpEvaluation] Parse-fail ignored — no longer evaluating (rfpId=${rfpId})`);
      }
    }
  }, WATCHER_INTERVAL_MS);

  activeWatchers.set(rfpId, interval);
}

/**
 * Restart watchers (or re-kick dead agents) for RFPs stuck in `evaluating`
 * after a server restart killed the in-memory watcher.
 */
export async function recoverEvaluatingRfps(): Promise<number> {
  const evaluating = await db.query.rfpRequests.findMany({
    where: eq(rfpRequests.aiStatus, 'evaluating'),
    columns: { id: true, aiThreadId: true },
  });

  let recovered = 0;
  for (const request of evaluating) {
    if (isWatcherActive(request.id)) continue;

    if (!request.aiThreadId) {
      console.log(`[rfpEvaluation] Recovery restart (no thread) — rfpId=${request.id}`);
      await autoStartEvaluation(request.id);
      recovered += 1;
      continue;
    }

    const ok = await hydrateThread(request.aiThreadId);
    if (!ok) {
      console.warn(
        `[rfpEvaluation] Recovery hydrate failed — marking failed (rfpId=${request.id}, threadId=${request.aiThreadId})`,
      );
      await markEvaluationFailedIfEvaluating(request.id);
      recovered += 1;
      continue;
    }

    const workspaceDir = await getWorkspaceDir(request.aiThreadId);
    const hasOutput = workspaceDir ? Boolean(readOutputFromWorkspace(workspaceDir)) : false;

    if (isThreadIdle(request.aiThreadId) && !hasOutput) {
      console.log(
        `[rfpEvaluation] Recovery re-kick dead agent — rfpId=${request.id} threadId=${request.aiThreadId}`,
      );
      await autoStartEvaluation(request.id);
      recovered += 1;
      continue;
    }

    startWatcher(request.id, request.aiThreadId);
    recovered += 1;
    console.log(
      `[rfpEvaluation] Recovery restarted watcher — rfpId=${request.id} threadId=${request.aiThreadId}`,
    );
  }

  return recovered;
}
