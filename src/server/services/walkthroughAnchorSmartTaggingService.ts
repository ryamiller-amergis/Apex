/**
 * Smart Anchor Management — async Cursor SDK smart-tagging orchestration.
 * Mirrors walkthroughGenerationService: start → poll status → cancel.
 * On success, merges validated suggestions onto pending catalog rows only.
 * On AI failure, leaves scan/catalog state reviewable (no destructive writes).
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
import { listWalkthroughRoutes } from '../../shared/walkthroughRoutes';
import {
  DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
  WALKTHROUGH_ANCHOR_SMART_TAGGING_OUTPUT_RELATIVE_PATH,
  WalkthroughAnchorSmartTaggingError,
  parseWalkthroughAnchorSmartTaggingOutput,
  type WalkthroughAnchorSmartTagMergeProvenanceBase,
  type WalkthroughAnchorSmartTaggingResult,
} from '../../shared/types/walkthroughAnchorSmartTagging';
import type { WalkthroughAnchorRegistryRecord } from '../../shared/types/walkthroughAnchorRegistry';
import * as walkthroughAnchorRegistryService from './walkthroughAnchorRegistryService';
import {
  APEX_WALKTHROUGH_PROJECT,
  listApplicableWalkthroughPageModules,
} from './walkthroughPageModuleScope';

export {
  DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
  SMART_TAG_COUNT_MAX,
  SMART_TAG_COUNT_MIN,
  WALKTHROUGH_ANCHOR_SMART_TAGGING_OUTPUT_RELATIVE_PATH,
  WalkthroughAnchorSmartTaggingError,
  applyValidatedSmartTagSuggestions,
  parseWalkthroughAnchorSmartTaggingOutput,
  validateWalkthroughAnchorSmartTaggingResult,
} from '../../shared/types/walkthroughAnchorSmartTagging';

export type {
  WalkthroughAnchorSmartTagMergeProvenanceBase,
  WalkthroughAnchorSmartTagMergeTarget,
  WalkthroughAnchorSmartTagSuggestion,
  WalkthroughAnchorSmartTaggingResult,
  WalkthroughAnchorSmartTaggingValidationCode,
  WalkthroughAnchorSmartTaggingValidationError,
} from '../../shared/types/walkthroughAnchorSmartTagging';

// ── Constants ────────────────────────────────────────────────────────────────

const APEX_REPOSITORY_PROJECT = APEX_WALKTHROUGH_PROJECT;
const SKILL_PATH_PATTERN = /^\.cursor\/skills\/[^/]+\/SKILL\.md$/;
const OUTPUT_RELATIVE_PATH = [
  ...WALKTHROUGH_ANCHOR_SMART_TAGGING_OUTPUT_RELATIVE_PATH,
];
const CATALOG_HINT_LIMIT = 40;
/** Cap candidates per Cursor run so large first-time syncs can finish. */
export const SMART_TAGGING_CANDIDATE_BATCH_MAX = 20;

const REVIEWABLE_WARNING =
  'Smart-tagging did not complete successfully. Newly discovered anchors remain pending and reviewable; scan state was not discarded.';

// ── Types ────────────────────────────────────────────────────────────────────

export type WalkthroughAnchorSmartTaggingStatus =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface WalkthroughAnchorSmartTaggingCandidateInput {
  testId: string;
  sourceLocations?: Array<{ filePath: string; line?: number | null }>;
  sourceKind?: string | null;
  codeSnippets?: string[];
}

export interface WalkthroughAnchorSmartTaggingStartRequest {
  /** Newly discovered candidate test IDs (+ optional source evidence). */
  candidates: WalkthroughAnchorSmartTaggingCandidateInput[];
  model?: string;
  skillPath?: string;
}

export type WalkthroughAnchorSmartTaggingProvenance = WalkthroughAnchorSmartTagMergeProvenanceBase;

export interface WalkthroughAnchorSmartTaggingStartResponse {
  threadId: string;
  provenance: WalkthroughAnchorSmartTaggingProvenance;
  /** Deduped newly discovered test IDs sent to the agent. */
  candidateTestIds: string[];
}

export interface WalkthroughAnchorSmartTaggingResultResponse {
  status: WalkthroughAnchorSmartTaggingStatus;
  rawJson?: string;
  result?: WalkthroughAnchorSmartTaggingResult;
  provenance?: WalkthroughAnchorSmartTaggingProvenance;
  /** Catalog rows updated on successful merge (pending only). */
  updated?: WalkthroughAnchorRegistryRecord[];
  error?: string;
  /**
   * Present on AI/parse failure: catalog rows stay pending/reviewable.
   * UI should surface this without treating scan state as lost.
   */
  warning?: string;
}

export class WalkthroughAnchorSmartTaggingOrchestrationError extends Error {
  readonly code: 'INVALID_REQUEST' | 'AI_FAILED' | 'NOT_FOUND';

  constructor(
    code: 'INVALID_REQUEST' | 'AI_FAILED' | 'NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'WalkthroughAnchorSmartTaggingOrchestrationError';
    this.code = code;
  }
}

// ── In-memory state ──────────────────────────────────────────────────────────

const cancelledThreads = new Set<string>();
const taggingInFlight = new Set<string>();
const provenanceByThread = new Map<
  string,
  WalkthroughAnchorSmartTaggingProvenance
>();
const candidateTestIdsByThread = new Map<string, string[]>();
const appliedThreads = new Set<string>();
const updatedByThread = new Map<string, WalkthroughAnchorRegistryRecord[]>();

export function _getSmartTaggingInFlightForTests(): ReadonlySet<string> {
  return taggingInFlight;
}

export function _resetForTests(): void {
  cancelledThreads.clear();
  taggingInFlight.clear();
  provenanceByThread.clear();
  candidateTestIdsByThread.clear();
  appliedThreads.clear();
  updatedByThread.clear();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RepositoryConnection {
  repo: string;
  branch: string;
  skillProvider: 'ado' | 'github';
}

function resolveLocalRepositoryConnection(
  repositoryRoot = process.cwd()
): RepositoryConnection | null {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_ENV === 'test'
  ) {
    return null;
  }

  try {
    const gitDir = path.join(repositoryRoot, '.git');
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf-8');
    const originSection = config.match(
      /\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/i
    )?.[1];
    const remoteUrl = originSection
      ?.match(/^\s*url\s*=\s*(.+)\s*$/im)?.[1]
      ?.trim();
    if (!remoteUrl) return null;

    const githubMatch = remoteUrl.match(
      /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i
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
      /dev\.azure\.com\/[^/]+\/([^/]+)\/_git\/([^/?#\s]+)/i
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

function validateSkillPath(skillPath: string | undefined): string {
  if (!skillPath) return DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH;
  const normalized = skillPath.replace(/^\//, '').replace(/\\/g, '/');
  if (!SKILL_PATH_PATTERN.test(normalized)) {
    throw new WalkthroughAnchorSmartTaggingOrchestrationError(
      'INVALID_REQUEST',
      'skillPath must match .cursor/skills/*/SKILL.md'
    );
  }
  return normalized;
}

function normalizeCandidates(
  candidates: WalkthroughAnchorSmartTaggingCandidateInput[] | undefined
): WalkthroughAnchorSmartTaggingCandidateInput[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new WalkthroughAnchorSmartTaggingOrchestrationError(
      'INVALID_REQUEST',
      'candidates must be a non-empty array of newly discovered test IDs'
    );
  }

  const seen = new Set<string>();
  const out: WalkthroughAnchorSmartTaggingCandidateInput[] = [];
  for (const raw of candidates) {
    const testId = typeof raw?.testId === 'string' ? raw.testId.trim() : '';
    if (!testId || seen.has(testId)) continue;
    // Skip scanner false-positives like template placeholders.
    if (testId.includes('${') || testId.includes('`')) continue;
    seen.add(testId);
    out.push({
      testId,
      sourceLocations: Array.isArray(raw.sourceLocations)
        ? raw.sourceLocations
            .filter(
              (loc) =>
                loc && typeof loc.filePath === 'string' && loc.filePath.trim()
            )
            .map((loc) => ({
              filePath: loc.filePath.trim(),
              line: loc.line ?? null,
            }))
        : undefined,
      sourceKind: raw.sourceKind ?? null,
      codeSnippets: Array.isArray(raw.codeSnippets)
        ? raw.codeSnippets.filter(
            (s): s is string => typeof s === 'string' && s.trim().length > 0
          )
        : undefined,
    });
    if (out.length >= SMART_TAGGING_CANDIDATE_BATCH_MAX) break;
  }

  if (out.length === 0) {
    throw new WalkthroughAnchorSmartTaggingOrchestrationError(
      'INVALID_REQUEST',
      'candidates must include at least one non-empty testId'
    );
  }

  return out;
}

/**
 * Keep only newly discovered IDs: unknown to catalog, or pending (not yet reviewed).
 * Approved / rejected rows are excluded so AI does not re-tag curated anchors.
 */
async function filterNewlyDiscovered(
  candidates: WalkthroughAnchorSmartTaggingCandidateInput[]
): Promise<WalkthroughAnchorSmartTaggingCandidateInput[]> {
  const filtered: WalkthroughAnchorSmartTaggingCandidateInput[] = [];
  for (const candidate of candidates) {
    const existing = await walkthroughAnchorRegistryService.getAnchorByTestId(
      candidate.testId
    );
    if (!existing || existing.reviewStatus === 'pending') {
      filtered.push(candidate);
    }
  }
  if (filtered.length === 0) {
    throw new WalkthroughAnchorSmartTaggingOrchestrationError(
      'INVALID_REQUEST',
      'No newly discovered (pending) candidates remain after filtering approved/rejected catalog rows'
    );
  }
  return filtered;
}

async function buildKickoffContext(
  candidates: WalkthroughAnchorSmartTaggingCandidateInput[]
): Promise<string> {
  const routes = listWalkthroughRoutes();
  const accessiblePageModules = await listApplicableWalkthroughPageModules();
  let existingCatalogHints: Array<{
    testId: string;
    anchorKey: string;
    label: string;
    smartTags: readonly string[];
    suggestedRoute: string | null;
    approvedRoute: string | null;
  }> = [];

  try {
    const page = await walkthroughAnchorRegistryService.listAnchors({
      reviewStatus: 'approved',
      limit: CATALOG_HINT_LIMIT,
    });
    existingCatalogHints = page.items.map((row) => ({
      testId: row.testId,
      anchorKey: row.anchorKey,
      label: row.label,
      smartTags: row.smartTags,
      suggestedRoute: row.suggestedRoute,
      approvedRoute: row.approvedRoute,
    }));
  } catch {
    existingCatalogHints = [];
  }

  const lines = [
    '# Walkthrough Anchor Smart Tagging Request',
    '',
    `**Source application:** ${APEX_REPOSITORY_PROJECT}`,
    '',
    'Classify only the newly discovered candidates below. Do not invent routes or UI.',
    'Tags must include meaningful tokens already present in each testId (e.g. ado-create-error → ado, create, error) plus domain/UI/intent tags.',
    `Return exactly one suggestion for each of the ${candidates.length} candidates. Do not omit candidates.`,
    'Resolve each candidate to its actual hosting page module by tracing imports/render references upward from shared components to the page entries listed below.',
    'Use the matched page entry suggestedRoute. It is the stable route users follow to enter that page workflow, including page-specific query tabs where applicable.',
    '',
    '## Candidates',
    '',
    JSON.stringify(candidates, null, 2),
    '',
    '## Accessible Page Modules',
    '',
    'These are all application modules managed from Platform Admin, plus fixed Home, Admin, and Profile modules. Each candidate was pre-filtered to these page import trees.',
    '',
    JSON.stringify(accessiblePageModules, null, 2),
    '',
    '## Curated Routes',
    '',
    JSON.stringify(
      routes.map((r) => ({ route: r.route, label: r.label })),
      null,
      2
    ),
    '',
    '## Existing Catalog Hints',
    '',
    JSON.stringify(existingCatalogHints, null, 2),
    '',
    '## Output',
    '',
    `Write validated JSON to ${OUTPUT_RELATIVE_PATH.join('/')}.`,
  ];

  return lines.join('\n');
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
  userId: string
): Promise<{ userId: string; workspaceDir: string | null; status: string }> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { userId: true, workspaceDir: true, status: true },
  });
  if (!row || row.userId !== userId) {
    throw new WalkthroughAnchorSmartTaggingOrchestrationError(
      'NOT_FOUND',
      'Smart-tagging thread not found.'
    );
  }
  return row;
}

function failedResponse(
  provenance: WalkthroughAnchorSmartTaggingProvenance | undefined,
  error: string
): WalkthroughAnchorSmartTaggingResultResponse {
  return {
    status: 'failed',
    error,
    warning: REVIEWABLE_WARNING,
    provenance,
  };
}

// ── startSmartTagging ────────────────────────────────────────────────────────

export async function startSmartTagging(
  request: WalkthroughAnchorSmartTaggingStartRequest,
  userId: string
): Promise<WalkthroughAnchorSmartTaggingStartResponse> {
  const normalized = normalizeCandidates(request.candidates);
  const candidates = await filterNewlyDiscovered(normalized);

  const savedOptions = await getWalkthroughAiOptions().catch(() => null);
  const skillPath = validateSkillPath(
    request.skillPath?.trim() || savedOptions?.anchorSmartTaggingSkillPath,
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
    throw new WalkthroughAnchorSmartTaggingOrchestrationError(
      'AI_FAILED',
      'The Apex project has no connected repository configured, and no local Apex Git remote could be resolved.'
    );
  }

  const globalModel = await getDefaultModel();
  const model =
    request.model?.trim() ||
    savedOptions?.anchorSmartTaggingModel?.trim() ||
    skillConfig?.developmentModel ||
    globalModel;

  const freeformContext = await buildKickoffContext(candidates);

  const thread = await createChatThread(userId, {
    project: APEX_REPOSITORY_PROJECT,
    repo: repositoryConnection.repo,
    branch: repositoryConnection.branch,
    skillProvider: repositoryConnection.skillProvider,
    skillPath,
    freeformContext,
    model,
  });

  const provenance: WalkthroughAnchorSmartTaggingProvenance = {
    provider: 'cursor',
    model,
    skillPath,
    generatedAt: new Date().toISOString(),
    threadId: thread.id,
    runId: null,
  };

  const candidateTestIds = candidates.map((c) => c.testId);

  cancelledThreads.delete(thread.id);
  appliedThreads.delete(thread.id);
  updatedByThread.delete(thread.id);
  taggingInFlight.add(thread.id);
  provenanceByThread.set(thread.id, provenance);
  candidateTestIdsByThread.set(thread.id, candidateTestIds);

  void (async () => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    });
    taggingInFlight.delete(thread.id);
  })();

  return { threadId: thread.id, provenance, candidateTestIds };
}

// ── getSmartTaggingResult ────────────────────────────────────────────────────

export async function getSmartTaggingResult(
  threadId: string,
  userId: string
): Promise<WalkthroughAnchorSmartTaggingResultResponse> {
  const row = await loadThreadForUser(threadId, userId);
  const provenance = provenanceByThread.get(threadId);

  if (cancelledThreads.has(threadId)) {
    return { status: 'cancelled', provenance };
  }

  if (taggingInFlight.has(threadId)) {
    return { status: 'pending', provenance };
  }

  if (!row.workspaceDir) {
    return { status: 'pending', provenance };
  }

  const raw = readOutput(row.workspaceDir);
  if (!raw) {
    if (isThreadIdle(threadId)) {
      return failedResponse(
        provenance,
        'Agent completed without generating smart-tagging output.'
      );
    }
    // After a server restart the in-memory agent is gone but DB may still say
    // "running". isThreadIdle() returns false for missing threads, which used
    // to leave the Sync UI polling forever.
    if (!isThreadLoaded(threadId)) {
      return failedResponse(
        provenance,
        'Smart-tagging agent is no longer running (server may have restarted). Use Tag next AI batch to retry.'
      );
    }
    return { status: 'pending', provenance };
  }

  let parsed: WalkthroughAnchorSmartTaggingResult;
  try {
    parsed = parseWalkthroughAnchorSmartTaggingOutput(raw);
  } catch (err) {
    const message =
      err instanceof WalkthroughAnchorSmartTaggingError
        ? err.message
        : 'Smart-tagging output is not valid JSON.';
    return failedResponse(provenance, message);
  }

  const expectedTestIds = candidateTestIdsByThread.get(threadId) ?? [];
  const returnedTestIds = new Set(
    parsed.suggestions.map((suggestion) => suggestion.testId)
  );
  const missingTestIds = expectedTestIds.filter(
    (testId) => !returnedTestIds.has(testId)
  );
  if (missingTestIds.length > 0) {
    return failedResponse(
      provenance,
      `Smart-tagging returned a partial batch (${parsed.suggestions.length}/${expectedTestIds.length}). Missing: ${missingTestIds.join(', ')}`
    );
  }

  let updated = updatedByThread.get(threadId) ?? [];
  if (!appliedThreads.has(threadId)) {
    const testIds =
      candidateTestIdsByThread.get(threadId) ??
      parsed.suggestions.map((s) => s.testId);

    const provenanceBase: WalkthroughAnchorSmartTagMergeProvenanceBase =
      provenance ?? {
        provider: 'cursor',
        model: 'unknown',
        skillPath: DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
        generatedAt: new Date().toISOString(),
        threadId,
        runId: null,
      };

    try {
      updated =
        await walkthroughAnchorRegistryService.applySmartTagSuggestionsToPending(
          {
            testIds,
            result: parsed,
            provenanceBase,
            actor: { id: userId },
          }
        );
      appliedThreads.add(threadId);
      updatedByThread.set(threadId, updated);
    } catch (err) {
      // Persist failure should not discard scan state; surface as failed+warning.
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to persist smart-tag suggestions.';
      return failedResponse(provenance, message);
    }
  }

  return {
    status: 'ready',
    rawJson: raw,
    result: parsed,
    provenance,
    updated,
  };
}

// ── cancelSmartTagging ───────────────────────────────────────────────────────

export async function cancelSmartTagging(
  threadId: string,
  userId: string
): Promise<void> {
  await loadThreadForUser(threadId, userId);
  await cancelChatRun(threadId);
  cancelledThreads.add(threadId);
  taggingInFlight.delete(threadId);
}
