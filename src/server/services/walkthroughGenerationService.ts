/**
 * FEAT-004 — Cursor SDK-backed async Walkthrough generation.
 * Mirrors the loadTestAiGenerationService / designModuleScopingService pattern:
 * start → poll status → cancel. Long SDK runs never hold an HTTP request open.
 *
 * Phase 7: tag-aware ranking injects approved+active catalog candidates into
 * kickoff context and the start response for staged review / auto-select.
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
import {
  listAnchors,
  listAuthoringAnchorEntries,
} from './walkthroughAnchorRegistryService';
import {
  DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD,
  pickAutoSelectAnchorCandidate,
  rankWalkthroughAnchorsByTags,
  type RankedWalkthroughAnchorCandidate,
  type WalkthroughAnchorTagRankingQuery,
} from './walkthroughAnchorTagRanking';
import type { WalkthroughAnchorRegistryEntry } from '../../shared/walkthroughAnchors';
import { listWalkthroughRoutes } from '../../shared/walkthroughRoutes';
import {
  listPublicWalkthroughAssetPaths,
  parseGeneratedWalkthroughProposal,
} from './walkthroughAiDraftService';
import {
  DEFAULT_WALKTHROUGH_AI_POLICY_PRESET,
  WalkthroughAiError,
  buildProposalUnits,
  type GenerateWalkthroughAiDraftRequest,
  type WalkthroughAiPolicyPresetId,
  type WalkthroughAiProposal,
} from '../../shared/types/walkthroughAiDraft';
import type { WalkthroughAnchorRegistryRecord } from '../../shared/types/walkthroughAnchorRegistry';
import type { WalkthroughGenerationProvenance } from '../../shared/types/walkthrough';

// ── Constants ────────────────────────────────────────────────────────────────────

export const DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH =
  '.cursor/skills/walkthrough-generation/SKILL.md';

/** Max ranked catalog candidates injected into kickoff / start response. */
export const DEFAULT_GENERATION_ANCHOR_RANK_LIMIT = 12;

const APEX_REPOSITORY_PROJECT = 'Apex';
const OUTPUT_RELATIVE_PATH = ['.ai-pilot', 'output', 'walkthrough-generation.json'];

const SKILL_PATH_PATTERN = /^\.cursor\/skills\/[^/]+\/SKILL\.md$/;
const CATALOG_PAGE_LIMIT = 200;

// ── Types ────────────────────────────────────────────────────────────────────────

export interface WalkthroughGenerationAnchorRanking {
  rankedCandidates: RankedWalkthroughAnchorCandidate[];
  /** Present only when the top candidate clears the conservative threshold. */
  autoSelectedAnchor: RankedWalkthroughAnchorCandidate | null;
  autoSelectThreshold: number;
}

export interface WalkthroughGenerationStartResponse {
  threadId: string;
  provenance: WalkthroughGenerationProvenance;
  /** Tag-ranked approved+active anchors for kickoff grounding + staged review. */
  anchorRanking: WalkthroughGenerationAnchorRanking;
}

export type WalkthroughGenerationStatus = 'pending' | 'ready' | 'failed' | 'cancelled';

export interface WalkthroughGenerationResultResponse {
  status: WalkthroughGenerationStatus;
  rawJson?: string;
  proposal?: WalkthroughAiProposal;
  provenance?: WalkthroughGenerationProvenance;
  error?: string;
}

// ── In-memory state ──────────────────────────────────────────────────────────────

const cancelledThreads = new Set<string>();
const generationInFlight = new Set<string>();
const provenanceByThread = new Map<string, WalkthroughGenerationProvenance>();
const policyByThread = new Map<string, WalkthroughAiPolicyPresetId>();
const rankingByThread = new Map<string, WalkthroughGenerationAnchorRanking>();

export function _getGenerationInFlightForTests(): ReadonlySet<string> {
  return generationInFlight;
}

export function _resetForTests(): void {
  cancelledThreads.clear();
  generationInFlight.clear();
  provenanceByThread.clear();
  policyByThread.clear();
  rankingByThread.clear();
}

/**
 * Annotate proposal steps with server-derived ranking metadata for staged review.
 *
 * Trust the AI's anchor selection: any `anchor.key` the model emits has already
 * been validated against the approved+active authoring catalog allow-list during
 * proposal parsing, so we do NOT second-guess it with the deterministic tag-overlap
 * score. `belowThreshold` therefore reflects only whether an anchor is attached at
 * all (i.e. a centered step), not the heuristic score. The `score` is retained for
 * informational display / telemetry.
 */
export function annotateProposalStepsWithAnchorMatch(
  proposal: WalkthroughAiProposal,
  ranking: WalkthroughGenerationAnchorRanking | undefined,
): WalkthroughAiProposal {
  const byKey = new Map(
    (ranking?.rankedCandidates ?? []).map((c) => [c.anchorKey, c] as const),
  );

  const steps = proposal.steps.map((step) => {
    const key = step.anchor?.key?.trim() || '';
    const hasAnchor = Boolean(key);
    const candidate = hasAnchor ? byKey.get(key) : undefined;
    const score = candidate?.score ?? 0;
    // Only anchorless steps are "below threshold" (they become centered steps).
    // An AI-selected catalog anchor is trusted regardless of its heuristic score.
    const belowThreshold = !hasAnchor;
    return {
      ...step,
      anchorMatch: {
        score,
        belowThreshold,
        hasAnchor,
        // A validated, AI-selected catalog anchor is route-compatible by construction.
        routeCompatible: hasAnchor
          ? (candidate?.evidence.routeCompatible ?? true)
          : false,
        matchedTags: [...(candidate?.evidence.matchedTags ?? [])],
      },
    };
  });

  return {
    ...proposal,
    steps,
    units: buildProposalUnits(proposal.walkthroughFields, steps),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

interface WalkthroughRepositoryConnection {
  repo: string;
  branch: string;
  skillProvider: 'ado' | 'github';
}

function resolveLocalRepositoryConnection(
  repositoryRoot = process.cwd(),
): WalkthroughRepositoryConnection | null {
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

function validateSkillPath(skillPath: string | undefined): string {
  if (!skillPath) return DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH;
  const normalized = skillPath.replace(/^\//, '').replace(/\\/g, '/');
  if (!SKILL_PATH_PATTERN.test(normalized)) {
    throw new WalkthroughAiError(
      'INTENT_INVALID',
      'skillPath must match .cursor/skills/*/SKILL.md',
    );
  }
  return normalized;
}

function emptyAnchorRanking(
  threshold = DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD,
): WalkthroughGenerationAnchorRanking {
  return {
    rankedCandidates: [],
    autoSelectedAnchor: null,
    autoSelectThreshold: threshold,
  };
}

/**
 * Derive ranking query from generation intent and optional existing draft
 * route / heading / body signals.
 */
export function buildGenerationAnchorRankingQuery(
  request: GenerateWalkthroughAiDraftRequest,
): WalkthroughAnchorTagRankingQuery {
  const steps = request.existingDraft?.steps ?? [];
  const route =
    steps.map((s) => s.route?.trim()).find((r) => Boolean(r)) ?? null;
  const headings = steps
    .map((s) => s.heading?.trim())
    .filter((h): h is string => Boolean(h));
  const bodies = steps
    .map((s) => s.bodyMarkdown?.trim())
    .filter((b): b is string => Boolean(b));

  return {
    route,
    intent: request.intent,
    heading: headings.length > 0 ? headings.join(' ') : null,
    body: bodies.length > 0 ? bodies.join(' ') : null,
  };
}

/** Rank approved+active catalog records for generation kickoff enrichment. */
export function buildWalkthroughGenerationAnchorRanking(
  records: readonly WalkthroughAnchorRegistryRecord[],
  request: GenerateWalkthroughAiDraftRequest,
  options: { limit?: number; threshold?: number } = {},
): WalkthroughGenerationAnchorRanking {
  const limit = options.limit ?? DEFAULT_GENERATION_ANCHOR_RANK_LIMIT;
  const threshold =
    options.threshold ?? DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD;
  const query = buildGenerationAnchorRankingQuery(request);
  const rankedCandidates = rankWalkthroughAnchorsByTags(records, query, {
    limit,
  });
  const autoSelectedAnchor = pickAutoSelectAnchorCandidate(
    rankedCandidates,
    query,
    { threshold },
  );

  return {
    rankedCandidates,
    autoSelectedAnchor,
    autoSelectThreshold: threshold,
  };
}

/** Markdown section injected into freeform kickoff context. */
export function formatAnchorRankingForKickoff(
  ranking: WalkthroughGenerationAnchorRanking,
): string {
  const lines = [
    '## Ranked Catalog Anchor Candidates',
    '',
    'Select coachmark `anchorKey` values **only** from `rankedCandidates` below.',
    'Prefer `autoSelectedAnchor` when it is non-null; otherwise leave ranking for staged review and do not invent keys.',
    '',
    '### Auto-selected Anchor',
    '',
  ];

  if (ranking.autoSelectedAnchor) {
    lines.push(JSON.stringify(ranking.autoSelectedAnchor, null, 2));
  } else {
    lines.push(
      'None — choose from ranked recommendations during staged review',
    );
  }

  lines.push(
    '',
    `### Ranked Recommendations (top ${ranking.rankedCandidates.length}, threshold ${ranking.autoSelectThreshold})`,
    '',
    JSON.stringify(
      {
        autoSelectThreshold: ranking.autoSelectThreshold,
        autoSelectedAnchor: ranking.autoSelectedAnchor,
        rankedCandidates: ranking.rankedCandidates,
      },
      null,
      2,
    ),
  );

  return lines.join('\n');
}

async function loadApprovedActiveCatalogAnchors(): Promise<
  WalkthroughAnchorRegistryRecord[]
> {
  const items: WalkthroughAnchorRegistryRecord[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await listAnchors({
      reviewStatus: 'approved',
      isActive: true,
      limit: CATALOG_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

/** Re-rank approved+active catalog anchors for one AI-draft step (staged review). */
export async function rankAnchorMatchesForAiDraftStep(
  query: WalkthroughAnchorTagRankingQuery,
  options: { limit?: number } = {},
): Promise<{
  rankedCandidates: RankedWalkthroughAnchorCandidate[];
  autoSelectThreshold: number;
}> {
  const records = await loadApprovedActiveCatalogAnchors();
  const limit = options.limit ?? DEFAULT_GENERATION_ANCHOR_RANK_LIMIT;
  const rankedCandidates = rankWalkthroughAnchorsByTags(records, query, {
    limit,
  });
  return {
    rankedCandidates,
    autoSelectThreshold: DEFAULT_ANCHOR_AUTO_SELECT_SCORE_THRESHOLD,
  };
}

async function resolveGenerationAnchorRanking(
  request: GenerateWalkthroughAiDraftRequest,
): Promise<WalkthroughGenerationAnchorRanking> {
  try {
    const records = await loadApprovedActiveCatalogAnchors();
    return buildWalkthroughGenerationAnchorRanking(records, request);
  } catch {
    return emptyAnchorRanking();
  }
}

function buildKickoffContext(
  request: GenerateWalkthroughAiDraftRequest,
  anchorRanking: WalkthroughGenerationAnchorRanking,
  authoringAnchors: readonly WalkthroughAnchorRegistryEntry[],
): string {
  const routes = listWalkthroughRoutes();
  const assets = listPublicWalkthroughAssetPaths();

  const lines = [
    `# Walkthrough Generation Request`,
    '',
    `**Source application:** ${APEX_REPOSITORY_PROJECT}`,
    '',
    `**Walkthrough target project:** ${request.projectId}`,
    '',
    `**Intent:** ${request.intent}`,
    '',
    '## Curated Routes',
    '',
    JSON.stringify(routes.map((r) => ({ route: r.route, label: r.label })), null, 2),
    '',
    formatAnchorRankingForKickoff(anchorRanking),
    '',
    '## Authoring Catalog Anchors (approved + active allow-list)',
    '',
    'For each candidate, use `testId` and `sourceLocations` to inspect the actual target in the repository. Detect targets rendered only after a modal, menu, tab, disclosure, or other conditional action. Use existing `openerAnchorKeys` in order; if a hidden target has no valid opener chain, prefer a visible alternative or a centered step rather than assuming it will appear.',
    '',
    JSON.stringify(
      authoringAnchors.map((a) => ({
        key: a.key,
        testId: a.testId,
        label: a.label,
        targetRoute: a.targetRoute,
        allowedPlacements: a.allowedPlacements,
        smartTags: a.smartTags ?? [],
        openerAnchorKeys: a.openerAnchorKeys ?? [],
        sourceLocations: a.sourceLocations ?? [],
      })),
      null,
      2,
    ),
    '',
    '## Allow-listed Image Assets',
    '',
    JSON.stringify(assets, null, 2),
  ];

  if (request.existingDraft) {
    lines.push('', '## Existing Draft (improve upon this)', '');
    lines.push(JSON.stringify(request.existingDraft, null, 2));
  }

  return lines.join('\n');
}

async function loadAuthoringCatalogForGeneration(): Promise<
  readonly WalkthroughAnchorRegistryEntry[]
> {
  try {
    return await listAuthoringAnchorEntries();
  } catch {
    return [];
  }
}

// ── startGeneration ──────────────────────────────────────────────────────────────

export async function startGeneration(
  request: GenerateWalkthroughAiDraftRequest,
  userId: string,
): Promise<WalkthroughGenerationStartResponse> {
  if (!request.projectId?.trim()) {
    throw new WalkthroughAiError('INTENT_INVALID', 'projectId is required');
  }
  if (!request.intent?.trim()) {
    throw new WalkthroughAiError('INTENT_INVALID', 'intent is required');
  }

  const savedOptions = await getWalkthroughAiOptions().catch(() => null);
  const skillPath = validateSkillPath(
    request.skillPath?.trim() || savedOptions?.walkthroughGenerationSkillPath,
  );

  // Walkthroughs teach Apex itself. Their audience project is request.projectId,
  // but repository grounding always comes from the Apex project's connection.
  const skillConfig = await resolveSkillConfig({ project: APEX_REPOSITORY_PROJECT });
  const repositoryConnection: WalkthroughRepositoryConnection | null = skillConfig?.skillRepo
    ? {
        repo: skillConfig.skillRepo,
        branch: skillConfig.skillBranch ?? 'main',
        skillProvider: skillConfig.skillProvider ?? 'ado',
      }
    : resolveLocalRepositoryConnection();
  if (!repositoryConnection) {
    throw new WalkthroughAiError(
      'AI_GENERATION_FAILED',
      'The Apex project has no connected repository configured, and no local Apex Git remote could be resolved.',
    );
  }

  const globalModel = await getDefaultModel();
  const model =
    request.model?.trim() ||
    savedOptions?.walkthroughGenerationModel?.trim() ||
    skillConfig?.developmentModel ||
    globalModel;

  const [anchorRanking, authoringAnchors] = await Promise.all([
    resolveGenerationAnchorRanking(request),
    loadAuthoringCatalogForGeneration(),
  ]);

  const thread = await createChatThread(userId, {
    project: APEX_REPOSITORY_PROJECT,
    repo: repositoryConnection.repo,
    branch: repositoryConnection.branch,
    skillProvider: repositoryConnection.skillProvider,
    skillPath,
    freeformContext: buildKickoffContext(request, anchorRanking, authoringAnchors),
    model,
  });

  const provenance: WalkthroughGenerationProvenance = {
    provider: 'cursor',
    model,
    skillPath,
    generatedAt: new Date().toISOString(),
    threadId: thread.id,
  };

  cancelledThreads.delete(thread.id);
  generationInFlight.add(thread.id);
  provenanceByThread.set(thread.id, provenance);
  rankingByThread.set(thread.id, anchorRanking);
  policyByThread.set(
    thread.id,
    request.policyPreset ?? DEFAULT_WALKTHROUGH_AI_POLICY_PRESET,
  );

  // Mark in-flight complete once thread starts processing
  void (async () => {
    // Wait briefly for thread creation to propagate; SDK kickoff is async.
    await new Promise((resolve) => setTimeout(resolve, 500));
    generationInFlight.delete(thread.id);
  })();

  return { threadId: thread.id, provenance, anchorRanking };
}

// ── getGenerationResult ──────────────────────────────────────────────────────────

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
    throw new WalkthroughAiError('AI_GENERATION_FAILED', 'Walkthrough generation thread not found.');
  }
  return row;
}

export async function getGenerationResult(
  threadId: string,
  userId: string,
): Promise<WalkthroughGenerationResultResponse> {
  const row = await loadThreadForUser(threadId, userId);
  const provenance = provenanceByThread.get(threadId);

  if (cancelledThreads.has(threadId)) {
    return { status: 'cancelled' };
  }

  if (generationInFlight.has(threadId)) {
    return { status: 'pending', provenance };
  }

  if (!row.workspaceDir) {
    return { status: 'pending', provenance };
  }

  const raw = readOutput(row.workspaceDir);
  if (!raw) {
    if (isThreadIdle(threadId)) {
      return {
        status: 'failed',
        error: 'Agent completed without generating a walkthrough proposal.',
        provenance,
      };
    }
    if (!isThreadLoaded(threadId)) {
      return {
        status: 'failed',
        error:
          'Walkthrough generation agent is no longer running (server may have restarted). Start generation again.',
        provenance,
      };
    }
    return { status: 'pending', provenance };
  }

  try {
    const parsed = JSON.parse(raw) as { steps?: unknown };
    if (!parsed || !Array.isArray(parsed.steps)) {
      return { status: 'failed', error: 'Generated output is missing steps array.', provenance };
    }
    // Phase 6: proposal allow-list is the DB authoring catalog, not DOM markers.
    const catalog = await listAuthoringAnchorEntries();
    const { proposal: parsedProposal } = parseGeneratedWalkthroughProposal(
      raw,
      policyByThread.get(threadId) ?? DEFAULT_WALKTHROUGH_AI_POLICY_PRESET,
      listPublicWalkthroughAssetPaths(),
      catalog,
    );
    const proposal = annotateProposalStepsWithAnchorMatch(
      parsedProposal,
      rankingByThread.get(threadId),
    );
    proposal.generationProvenance = provenance ?? null;
    return { status: 'ready', rawJson: raw, proposal, provenance };
  } catch (err) {
    return {
      status: 'failed',
      error:
        err instanceof WalkthroughAiError
          ? err.message
          : 'Generated output is not valid JSON.',
      provenance,
    };
  }
}

// ── cancelGeneration ─────────────────────────────────────────────────────────────

export async function cancelGeneration(
  threadId: string,
  userId: string,
): Promise<WalkthroughGenerationResultResponse> {
  await loadThreadForUser(threadId, userId);
  await cancelChatRun(threadId);
  cancelledThreads.add(threadId);
  generationInFlight.delete(threadId);
  policyByThread.delete(threadId);
  rankingByThread.delete(threadId);
  return { status: 'cancelled' };
}
