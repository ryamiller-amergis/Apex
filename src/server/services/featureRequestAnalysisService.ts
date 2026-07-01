import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { featureRequests, chatThreads } from '../db/schema';
import {
  isThreadIdle,
  createThread as createChatThread,
} from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';

const WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 720;
const OUTPUT_FILE = 'feature-request-analysis.json';

export interface FeatureRequestAnalysisResult {
  priority: string;
  risk: string;
  rationale: string;
}

const activeWatchers = new Map<string, ReturnType<typeof setInterval>>();

export function stopWatcher(requestId: string): void {
  const handle = activeWatchers.get(requestId);
  if (handle !== undefined) {
    clearInterval(handle);
    activeWatchers.delete(requestId);
    console.log(`[featureRequestAnalysis] Cancelled watcher — requestId=${requestId}`);
  }
}

export function isWatcherActive(requestId: string): boolean {
  return activeWatchers.has(requestId);
}

function resolveOutputPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.ai-pilot', 'output', OUTPUT_FILE);
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

async function updateAiFields(
  requestId: string,
  fields: {
    aiStatus: string;
    aiPriority?: string | null;
    aiRisk?: string | null;
    aiRationale?: string | null;
    aiThreadId?: string | null;
  },
): Promise<void> {
  await db
    .update(featureRequests)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(featureRequests.id, requestId));
}

export async function autoStartFeatureRequestAnalysis(requestId: string): Promise<void> {
  const request = await db.query.featureRequests.findFirst({
    where: eq(featureRequests.id, requestId),
  });
  if (!request) {
    console.warn(`[featureRequestAnalysis] Request not found — requestId=${requestId}`);
    return;
  }

  const project = 'Apex';
  const skillConfig = await resolveSkillConfig({ project });
  if (!skillConfig) {
    await updateAiFields(requestId, { aiStatus: 'failed' });
    console.warn(`[featureRequestAnalysis] No skill config for project=${project} — marking failed`);
    return;
  }

  const skillPath = skillConfig.featureRequestSkillPath;
  if (!skillPath) {
    await updateAiFields(requestId, { aiStatus: 'failed' });
    console.warn(`[featureRequestAnalysis] No featureRequestSkillPath configured — marking failed`);
    return;
  }

  const globalModel = await getDefaultModel();
  const model = skillConfig.featureRequestModel ?? skillConfig.defaultModel ?? globalModel;

  const freeformContext = [
    `Title: ${request.title}`,
    `Request: ${request.request}`,
    `Advantage: ${request.advantage}`,
  ].join('\n');

  const thread = await createChatThread('system', {
    project,
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch ?? 'main',
    skillProvider: skillConfig.skillProvider ?? 'ado',
    skillPath,
    freeformContext,
    model,
  });

  stopWatcher(requestId);
  await updateAiFields(requestId, { aiStatus: 'analyzing', aiThreadId: thread.id });
  startWatcher(requestId, thread.id);
}

export function startWatcher(requestId: string, threadId: string): void {
  stopWatcher(requestId);
  let attempts = 0;
  let workspaceDir: string | null = null;

  console.log(`[featureRequestAnalysis] Started watcher — requestId=${requestId} threadId=${threadId}`);

  const interval = setInterval(async () => {
    attempts += 1;

    if (attempts > WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activeWatchers.delete(requestId);
      console.warn(`[featureRequestAnalysis] Timed out — requestId=${requestId}`);
      await updateAiFields(requestId, { aiStatus: 'failed' });
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
        activeWatchers.delete(requestId);
        console.warn(`[featureRequestAnalysis] Agent completed without output — requestId=${requestId}`);
        await updateAiFields(requestId, { aiStatus: 'failed' });
      }
      return;
    }

    clearInterval(interval);
    activeWatchers.delete(requestId);

    try {
      const currentRequest = await db.query.featureRequests.findFirst({
        where: eq(featureRequests.id, requestId),
        columns: { aiThreadId: true },
      });
      if (currentRequest?.aiThreadId !== threadId) {
        console.log(`[featureRequestAnalysis] Discarded stale result — thread ${threadId} no longer active (requestId=${requestId})`);
        cleanupWorkspace(threadId);
        return;
      }

      const result = JSON.parse(raw) as FeatureRequestAnalysisResult;
      await updateAiFields(requestId, {
        aiStatus: 'complete',
        aiPriority: result.priority,
        aiRisk: result.risk,
        aiRationale: result.rationale,
      });
      console.log(`[featureRequestAnalysis] Analysis synced — priority=${result.priority} risk=${result.risk} (requestId=${requestId})`);
      cleanupWorkspace(threadId);
    } catch (err) {
      console.error(`[featureRequestAnalysis] Failed to parse/sync output (requestId=${requestId})`, err);
      await updateAiFields(requestId, { aiStatus: 'failed' });
    }
  }, WATCHER_INTERVAL_MS);

  activeWatchers.set(requestId, interval);
}

export async function reanalyzeFeatureRequest(requestId: string): Promise<void> {
  stopWatcher(requestId);
  await updateAiFields(requestId, {
    aiStatus: 'pending',
    aiPriority: null,
    aiRisk: null,
    aiRationale: null,
    aiThreadId: null,
  });
  await autoStartFeatureRequestAnalysis(requestId);
}
