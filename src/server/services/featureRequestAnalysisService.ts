import fs from 'fs';
import path from 'path';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { adrs, featureRequestAdrs, featureRequests, chatThreads } from '../db/schema';
import {
  isThreadIdle,
  hydrateThread,
  createThread as createChatThread,
} from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import type { WorkItemType } from '../../shared/types/featureRequest';

const WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 720;
const MAX_LINKED_ADR_CONTEXT_CHARS = 24_000;
const MAX_SINGLE_ADR_CHARS = 8_000;
const TYPE_CONFIG: Record<
  WorkItemType,
  {
    skillPathKey: 'featureRequestSkillPath' | 'technicalSkillPath' | 'issueSkillPath';
    modelKey: 'featureRequestModel' | 'technicalModel' | 'issueModel';
    outputFile: string;
  }
> = {
  feature: {
    skillPathKey: 'featureRequestSkillPath',
    modelKey: 'featureRequestModel',
    outputFile: 'feature-request-analysis.json',
  },
  technical: {
    skillPathKey: 'technicalSkillPath',
    modelKey: 'technicalModel',
    outputFile: 'technical-analysis.json',
  },
  issue: {
    skillPathKey: 'issueSkillPath',
    modelKey: 'issueModel',
    outputFile: 'issue-analysis.json',
  },
};

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

function resolveOutputPath(workspaceDir: string, type: WorkItemType): string {
  return path.join(workspaceDir, '.ai-pilot', 'output', TYPE_CONFIG[type].outputFile);
}

function readOutputFromWorkspace(workspaceDir: string, type: WorkItemType): string | null {
  const outputPath = resolveOutputPath(workspaceDir, type);
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

  const requestedType = request.type as WorkItemType;
  const type: WorkItemType = TYPE_CONFIG[requestedType] ? requestedType : 'feature';
  const config = TYPE_CONFIG[type];
  const skillPath = skillConfig[config.skillPathKey];
  if (!skillPath) {
    await updateAiFields(requestId, { aiStatus: 'failed' });
    console.warn(`[featureRequestAnalysis] No ${config.skillPathKey} configured — marking failed`);
    return;
  }

  const globalModel = await getDefaultModel();
  const model = skillConfig[config.modelKey] ?? skillConfig.defaultModel ?? globalModel;

  const contextLines = [`Type: ${type}`, `Title: ${request.title}`, `Description: ${request.request}`];
  if (type === 'feature' && request.advantage) {
    contextLines.push(`Advantage: ${request.advantage}`);
  } else if (type === 'technical') {
    contextLines.push('Analysis focus: technical approach, architecture impact, dependencies, and implementation risk.');
  } else if (type === 'issue') {
    contextLines.push('Analysis focus: user impact, likely severity, reproducibility clues, operational risk, and urgency.');
  }
  if (type !== 'issue') {
    const linkedAdrs = await db
      .select({
        id: adrs.id,
        title: adrs.title,
        project: adrs.project,
        repo: adrs.repo,
        slug: adrs.slug,
        content: adrs.content,
      })
      .from(featureRequestAdrs)
      .innerJoin(adrs, eq(featureRequestAdrs.adrId, adrs.id))
      .where(and(
        eq(featureRequestAdrs.featureRequestId, requestId),
        eq(adrs.status, 'accepted'),
      ));
    if (linkedAdrs.length > 0) {
      contextLines.push('', '## Linked accepted ADRs (architectural source context)');
      let remaining = MAX_LINKED_ADR_CONTEXT_CHARS;
      for (const adr of linkedAdrs) {
        if (remaining <= 0) break;
        const header = [
          `### ADR: ${adr.title}`,
          `ADR ID: ${adr.id}`,
          `Project: ${adr.project}`,
          `Repository: ${adr.repo}`,
          `Slug: ${adr.slug ?? '(none)'}`,
          'Accepted ADR markdown:',
        ].join('\n');
        const section = `${header}\n${adr.content.slice(0, MAX_SINGLE_ADR_CHARS)}`.slice(0, remaining);
        contextLines.push(section);
        remaining -= section.length;
      }
    }
  }
  const freeformContext = contextLines.join('\n');

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
  startWatcher(requestId, thread.id, type);
}

export function startWatcher(
  requestId: string,
  threadId: string,
  type: WorkItemType = 'feature',
): void {
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

    const raw = readOutputFromWorkspace(workspaceDir, type);

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

function resolveRequestType(type: string | null | undefined): WorkItemType {
  const requested = type as WorkItemType;
  return TYPE_CONFIG[requested] ? requested : 'feature';
}

/**
 * Restart watchers (or re-kick dead agents) for feature requests stuck in
 * `analyzing` after a server restart killed the in-memory watcher.
 */
export async function recoverAnalyzingFeatureRequests(): Promise<number> {
  const analyzing = await db.query.featureRequests.findMany({
    where: eq(featureRequests.aiStatus, 'analyzing'),
    columns: { id: true, type: true, aiThreadId: true },
  });

  let recovered = 0;
  for (const request of analyzing) {
    if (isWatcherActive(request.id)) continue;

    const type = resolveRequestType(request.type);
    if (!request.aiThreadId) {
      console.log(`[featureRequestAnalysis] Recovery restart (no thread) — requestId=${request.id}`);
      await autoStartFeatureRequestAnalysis(request.id);
      recovered += 1;
      continue;
    }

    const ok = await hydrateThread(request.aiThreadId);
    if (!ok) {
      console.warn(
        `[featureRequestAnalysis] Recovery hydrate failed — marking failed (requestId=${request.id}, threadId=${request.aiThreadId})`,
      );
      await updateAiFields(request.id, { aiStatus: 'failed' });
      recovered += 1;
      continue;
    }

    const workspaceDir = await getWorkspaceDir(request.aiThreadId);
    const hasOutput = workspaceDir ? Boolean(readOutputFromWorkspace(workspaceDir, type)) : false;

    if (isThreadIdle(request.aiThreadId) && !hasOutput) {
      console.log(
        `[featureRequestAnalysis] Recovery re-kick dead agent — requestId=${request.id} threadId=${request.aiThreadId}`,
      );
      await autoStartFeatureRequestAnalysis(request.id);
      recovered += 1;
      continue;
    }

    startWatcher(request.id, request.aiThreadId, type);
    recovered += 1;
    console.log(
      `[featureRequestAnalysis] Recovery restarted watcher — requestId=${request.id} threadId=${request.aiThreadId}`,
    );
  }

  return recovered;
}
