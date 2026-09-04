/**
 * Walkthrough AI anchor discovery — Cursor SDK async orchestration.
 * Mirrors walkthroughGenerationService / walkthroughAnchorSmartTaggingService:
 * start → poll status → cancel. Does not persist catalog rows (import is client-driven).
 */

import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads } from '../db/schema';
import {
  createThread as createChatThread,
  cancelRun as cancelChatRun,
  isThreadIdle,
  isThreadLoaded,
} from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import { getWalkthroughAiOptions } from './walkthroughAiOptionsService';
import { listAnchors } from './walkthroughAnchorRegistryService';
import { listWalkthroughRoutes } from '../../shared/walkthroughRoutes';
import {
  APEX_WALKTHROUGH_PROJECT,
  listApplicableWalkthroughPageModules,
} from './walkthroughPageModuleScope';
import {
  DEFAULT_WALKTHROUGH_ANCHOR_DISCOVERY_SKILL_PATH,
  WALKTHROUGH_ANCHOR_DISCOVERY_OUTPUT_RELATIVE_PATH,
  WalkthroughAnchorDiscoveryError,
  parseWalkthroughAnchorDiscoveryOutput,
  type WalkthroughAnchorDiscoveryResult,
} from '../../shared/types/walkthroughAnchorDiscovery';
import {
  isSupportedAgentSkillPath,
  normalizeRepoRelativePath,
} from '../../shared/skillPaths';

export {
  DEFAULT_WALKTHROUGH_ANCHOR_DISCOVERY_SKILL_PATH,
  WalkthroughAnchorDiscoveryError,
  parseWalkthroughAnchorDiscoveryOutput,
} from '../../shared/types/walkthroughAnchorDiscovery';

export type {
  WalkthroughAnchorDiscoveryProposal,
  WalkthroughAnchorDiscoveryResult,
} from '../../shared/types/walkthroughAnchorDiscovery';

const APEX_REPOSITORY_PROJECT = APEX_WALKTHROUGH_PROJECT;
const OUTPUT_RELATIVE_PATH = [...WALKTHROUGH_ANCHOR_DISCOVERY_OUTPUT_RELATIVE_PATH];
const CATALOG_PAGE_LIMIT = 200;

export type WalkthroughAnchorDiscoveryStatus =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface WalkthroughAnchorDiscoveryStartRequest {
  heading: string;
  body?: string | null;
  route?: string | null;
  intent?: string | null;
  model?: string;
  skillPath?: string;
}

export interface WalkthroughAnchorDiscoveryProvenance {
  provider: 'cursor';
  model: string;
  skillPath: string;
  generatedAt: string;
  threadId: string;
  runId: string | null;
}

export interface WalkthroughAnchorDiscoveryStartResponse {
  threadId: string;
  provenance: WalkthroughAnchorDiscoveryProvenance;
}

export interface WalkthroughAnchorDiscoveryResultResponse {
  status: WalkthroughAnchorDiscoveryStatus;
  rawJson?: string;
  result?: WalkthroughAnchorDiscoveryResult;
  provenance?: WalkthroughAnchorDiscoveryProvenance;
  error?: string;
}

export class WalkthroughAnchorDiscoveryOrchestrationError extends Error {
  readonly code: 'INVALID_REQUEST' | 'AI_FAILED' | 'NOT_FOUND';

  constructor(
    code: 'INVALID_REQUEST' | 'AI_FAILED' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'WalkthroughAnchorDiscoveryOrchestrationError';
    this.code = code;
  }
}

interface RepositoryConnection {
  repo: string;
  branch: string;
  skillProvider: 'ado' | 'github';
}

const cancelledThreads = new Set<string>();
const discoveryInFlight = new Set<string>();
const provenanceByThread = new Map<string, WalkthroughAnchorDiscoveryProvenance>();

export function _resetDiscoveryForTests(): void {
  cancelledThreads.clear();
  discoveryInFlight.clear();
  provenanceByThread.clear();
}

function validateSkillPath(skillPath: string | undefined): string {
  if (!skillPath) return DEFAULT_WALKTHROUGH_ANCHOR_DISCOVERY_SKILL_PATH;
  const normalized = normalizeRepoRelativePath(skillPath);
  if (!isSupportedAgentSkillPath(normalized)) {
    throw new WalkthroughAnchorDiscoveryOrchestrationError(
      'INVALID_REQUEST',
      'skillPath must use a supported Agent Skills root',
    );
  }
  return normalized;
}

function resolveLocalRepositoryConnection(
  repositoryRoot = process.cwd(),
): RepositoryConnection | null {
  if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test') {
    return null;
  }
  try {
    const gitDir = path.join(repositoryRoot, '.git');
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf-8');
    const originSection = config.match(
      /\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/i,
    )?.[1];
    const remoteUrl = originSection?.match(/^\s*url\s*=\s*(.+)\s*$/im)?.[1]?.trim();
    if (!remoteUrl) return null;

    const githubMatch = remoteUrl.match(
      /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    );
    if (githubMatch) {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
      return {
        repo: `${githubMatch[1]}/${githubMatch[2]}`,
        branch: head.match(/^ref:\s+refs\/heads\/(.+)$/)?.[1] ?? 'main',
        skillProvider: 'github',
      };
    }

    const adoMatch = remoteUrl.match(
      /dev\.azure\.com\/[^/]+\/([^/]+)\/_git\/([^/?#\s]+)/i,
    );
    if (adoMatch) {
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
      return {
        repo: `${decodeURIComponent(adoMatch[1])}/${decodeURIComponent(adoMatch[2])}`,
        branch: head.match(/^ref:\s+refs\/heads\/(.+)$/)?.[1] ?? 'main',
        skillProvider: 'ado',
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function loadExistingCatalogKeys(): Promise<string[]> {
  const keys = new Set<string>();
  let cursor: string | null | undefined;
  do {
    const page = await listAnchors({
      limit: CATALOG_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.items) {
      keys.add(item.anchorKey);
      keys.add(item.testId);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return [...keys].sort();
}

async function buildKickoffContext(
  request: WalkthroughAnchorDiscoveryStartRequest,
): Promise<string> {
  const curatedRoutes = listWalkthroughRoutes();
  const existingCatalogKeys = await loadExistingCatalogKeys();
  let accessiblePageModules: unknown = [];
  try {
    accessiblePageModules = await listApplicableWalkthroughPageModules();
  } catch {
    accessiblePageModules = [];
  }

  return [
    '# Walkthrough Anchor Discovery Request',
    '',
    '## Step',
    '',
    JSON.stringify(
      {
        heading: request.heading,
        body: request.body ?? null,
        route: request.route ?? null,
        intent: request.intent ?? null,
      },
      null,
      2,
    ),
    '',
    '## Curated Routes',
    '',
    JSON.stringify(curatedRoutes, null, 2),
    '',
    '## Existing Catalog Keys (do not propose)',
    '',
    JSON.stringify(existingCatalogKeys, null, 2),
    '',
    '## Accessible Page Modules',
    '',
    JSON.stringify(accessiblePageModules, null, 2),
    '',
    'Write proposals to `.ai-pilot/output/walkthrough-anchor-discovery.json`.',
  ].join('\n');
}

function resolveOutputPath(workspaceDir: string): string {
  return path.join(workspaceDir, ...OUTPUT_RELATIVE_PATH);
}

function readOutput(workspaceDir: string): string | null {
  const outputPath = resolveOutputPath(workspaceDir);
  if (!fs.existsSync(outputPath)) return null;
  try {
    return fs.readFileSync(outputPath, 'utf-8');
  } catch {
    return null;
  }
}

async function loadThreadForUser(
  threadId: string,
  userId: string,
): Promise<{ userId: string; workspaceDir: string | null; status: string }> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { userId: true, workspaceDir: true, status: true },
  });
  if (!row || row.userId !== userId) {
    throw new WalkthroughAnchorDiscoveryOrchestrationError(
      'NOT_FOUND',
      'Anchor discovery thread not found.',
    );
  }
  return row;
}

export async function startAnchorDiscovery(
  request: WalkthroughAnchorDiscoveryStartRequest,
  userId: string,
): Promise<WalkthroughAnchorDiscoveryStartResponse> {
  const heading = request.heading?.trim();
  if (!heading) {
    throw new WalkthroughAnchorDiscoveryOrchestrationError(
      'INVALID_REQUEST',
      'heading is required',
    );
  }

  const savedOptions = await getWalkthroughAiOptions().catch(() => null);
  const skillPath = validateSkillPath(
    request.skillPath?.trim() || savedOptions?.anchorDiscoverySkillPath,
  );

  const skillConfig = await resolveSkillConfig({
    project: APEX_REPOSITORY_PROJECT,
  });
  const repositoryConnection: RepositoryConnection | null =
    skillConfig?.skillRepo
      ? {
          repo: skillConfig.skillRepo,
          branch: skillConfig.skillBranch ?? 'main',
          skillProvider: skillConfig.skillProvider ?? 'ado',
        }
      : resolveLocalRepositoryConnection();
  if (!repositoryConnection) {
    throw new WalkthroughAnchorDiscoveryOrchestrationError(
      'AI_FAILED',
      'The Apex project has no connected repository configured, and no local Apex Git remote could be resolved.',
    );
  }

  const globalModel = await getDefaultModel();
  const model =
    request.model?.trim() ||
    savedOptions?.anchorDiscoveryModel?.trim() ||
    skillConfig?.developmentModel ||
    globalModel;

  const freeformContext = await buildKickoffContext({
    ...request,
    heading,
  });

  const thread = await createChatThread(userId, {
    project: APEX_REPOSITORY_PROJECT,
    repo: repositoryConnection.repo,
    branch: repositoryConnection.branch,
    skillProvider: repositoryConnection.skillProvider,
    skillPath,
    freeformContext,
    model,
  });

  const provenance: WalkthroughAnchorDiscoveryProvenance = {
    provider: 'cursor',
    model,
    skillPath,
    generatedAt: new Date().toISOString(),
    threadId: thread.id,
    runId: null,
  };

  cancelledThreads.delete(thread.id);
  discoveryInFlight.add(thread.id);
  provenanceByThread.set(thread.id, provenance);

  void (async () => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    });
    discoveryInFlight.delete(thread.id);
  })();

  return { threadId: thread.id, provenance };
}

export async function getAnchorDiscoveryResult(
  threadId: string,
  userId: string,
): Promise<WalkthroughAnchorDiscoveryResultResponse> {
  const row = await loadThreadForUser(threadId, userId);
  const provenance = provenanceByThread.get(threadId);

  if (cancelledThreads.has(threadId)) {
    return { status: 'cancelled' };
  }
  if (!row.workspaceDir) {
    return { status: 'pending', provenance };
  }

  // Output wins over run state: agents hold the kickoff sendMessage promise open
  // after writing the file, and waiting for it stalls callers that already have
  // a usable result.
  const raw = readOutput(row.workspaceDir);
  if (!raw) {
    if (discoveryInFlight.has(threadId)) {
      return { status: 'pending', provenance };
    }
    if (isThreadIdle(threadId)) {
      return {
        status: 'failed',
        error: 'Agent completed without generating discovery output.',
        provenance,
      };
    }
    if (!isThreadLoaded(threadId)) {
      return {
        status: 'failed',
        error:
          'Anchor discovery agent is no longer running (server may have restarted). Start discovery again.',
        provenance,
      };
    }
    return { status: 'pending', provenance };
  }

  try {
    const result = parseWalkthroughAnchorDiscoveryOutput(raw);
    return { status: 'ready', rawJson: raw, result, provenance };
  } catch (err) {
    return {
      status: 'failed',
      error:
        err instanceof WalkthroughAnchorDiscoveryError
          ? err.message
          : 'Discovery output is not valid JSON.',
      provenance,
    };
  }
}

export async function cancelAnchorDiscovery(
  threadId: string,
  userId: string,
): Promise<WalkthroughAnchorDiscoveryResultResponse> {
  await loadThreadForUser(threadId, userId);
  await cancelChatRun(threadId);
  cancelledThreads.add(threadId);
  discoveryInFlight.delete(threadId);
  return { status: 'cancelled' };
}
