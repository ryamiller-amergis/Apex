import { and, eq } from 'drizzle-orm';
import type {
  GroundingBranchMovedEvent,
  GroundingNotificationVolume,
  GroundingRunImpactContext,
} from '../../shared/types/groundingOperations';
import type { RunGrounding } from '../../shared/types/runGrounding';
import { db } from '../db/drizzle';
import { chatThreads, userProjectAssignments } from '../db/schema';
import { getDefaultModel } from './appSettingsService';
import {
  isFeatureOperational,
  isGroundingEnabledForCaller,
} from './featureFlagService';
import {
  groundingTelemetry,
  type GroundingTelemetry,
} from './groundingTelemetry';
import { createNotification } from './notificationService';
import { resolveSkillConfig } from './projectSettingsService';
import { runGroundingService } from './runGroundingService';
import { runImpactContextRegistry } from './runImpactContextRegistry';

const MAX_AI_CANDIDATES = 20;

export interface GroundingAiRelevanceInput {
  run: RunGrounding;
  runTitle: string;
  changedFiles: string[];
  fromSha: string;
  toSha: string;
  modelId: string;
}

interface NotificationPayload {
  type: 'ai';
  title: string;
  body: string;
  link?: string;
}

export interface GroundingImpactEvaluatorDependencies {
  findActiveByRepoBranch(
    query: Pick<
      GroundingBranchMovedEvent,
      'provider' | 'project' | 'repository' | 'branch'
    >
  ): Promise<RunGrounding[]>;
  resolveRun(
    grounding: RunGrounding
  ): Promise<GroundingRunImpactContext | null>;
  hasProjectAccess(userId: string, project: string): Promise<boolean>;
  heuristicFilter(
    changedFiles: string[],
    grounding: RunGrounding,
    context: GroundingRunImpactContext
  ): string[];
  evaluateAiRelevance(input: GroundingAiRelevanceInput): Promise<boolean>;
  isOperationalEnabled(): Promise<boolean>;
  isCallerEnabled(context: {
    userId: string;
    project: string;
    caller: string;
  }): Promise<boolean>;
  resolveModel?(project: string): Promise<string>;
  createNotification(
    userId: string,
    payload: NotificationPayload,
    options: { dedupeKey: string }
  ): Promise<unknown>;
  telemetry: Pick<GroundingTelemetry, 'notification'>;
}

export interface GroundingImpactEvaluatorService {
  evaluate(
    event: GroundingBranchMovedEvent
  ): Promise<GroundingNotificationVolume>;
  enqueue(event: GroundingBranchMovedEvent): void;
}

const NOISY_FILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
]);
const NOISY_EXTENSIONS = /\.(?:bmp|gif|ico|jpe?g|map|pdf|png|webp)$/i;

function normalizeRepositoryPath(filePath: string): string | null {
  const normalized = filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.startsWith('//')
  ) {
    return null;
  }
  return normalized;
}

function filterNoisyChangedFiles(changedFiles: string[]): string[] {
  return [
    ...new Set(
      changedFiles.flatMap((filePath) => {
        const normalized = normalizeRepositoryPath(filePath);
        if (!normalized) return [];
        const name = normalized.split('/').pop()?.toLowerCase() ?? '';
        return NOISY_FILE_NAMES.has(name) || NOISY_EXTENSIONS.test(normalized)
          ? []
          : [normalized];
      })
    ),
  ];
}

function scopeMatches(filePath: string, scopePath: string): boolean {
  const normalizedScope = normalizeRepositoryPath(scopePath);
  if (!normalizedScope) return false;
  const prefix = normalizedScope
    .replace(/\/\*\*\/\*$/, '')
    .replace(/\/\*\*$/, '')
    .replace(/\/\*$/, '');
  return (
    filePath === prefix ||
    filePath.startsWith(`${prefix}/`) ||
    normalizedScope === filePath
  );
}

export function defaultGroundingImpactHeuristic(
  changedFiles: string[],
  _grounding: RunGrounding,
  context: GroundingRunImpactContext
): string[] {
  const usefulFiles = filterNoisyChangedFiles(changedFiles);
  if (!context.scopePaths?.length) return usefulFiles;
  return usefulFiles.filter((filePath) =>
    context.scopePaths?.some((scopePath) => scopeMatches(filePath, scopePath))
  );
}

export function groundingImpactDedupeKey(
  runId: string,
  groundedSha: string,
  newSha: string
): string {
  return `grounding-impact:${runId}:${groundedSha}:${newSha}`;
}

async function resolvePersistedRun(
  grounding: RunGrounding
): Promise<GroundingRunImpactContext | null> {
  if (grounding.runType !== 'chat') return null;
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, grounding.runId),
    columns: {
      userId: true,
      title: true,
      kickoff: true,
    },
  });
  const title = row?.title?.trim();
  if (!row?.userId || !title || row.kickoff.project !== grounding.project) {
    return null;
  }
  const { resolveGroundingCallerKey } = await import('./chatAgentService');
  return {
    authorId: row.userId,
    title,
    caller: resolveGroundingCallerKey(row.kickoff),
    link: `/home?thread=${encodeURIComponent(grounding.runId)}`,
    scopePaths:
      grounding.repoRole === 'skill' && row.kickoff.skillPath
        ? [row.kickoff.skillPath]
        : undefined,
  };
}

export async function resolveProductionRunImpactContext(
  grounding: RunGrounding
): Promise<GroundingRunImpactContext | null> {
  if (grounding.runType === 'chat') {
    try {
      const persisted = await resolvePersistedRun(grounding);
      if (persisted) return persisted;
    } catch {
      // A transient persisted lookup failure may still have a safe local context.
    }
  }
  return runImpactContextRegistry.resolve(grounding);
}

async function hasPersistedProjectAccess(
  userId: string,
  project: string
): Promise<boolean> {
  const rows = await db
    .select({ userId: userProjectAssignments.userId })
    .from(userProjectAssignments)
    .where(
      and(
        eq(userProjectAssignments.userId, userId),
        eq(userProjectAssignments.project, project)
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function resolveProjectDefaultModel(project: string): Promise<string> {
  const settings = await resolveSkillConfig({ project });
  return settings?.defaultModel || (await getDefaultModel());
}

function parseRelevance(output: string): boolean {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? output;
  const object = fenced.match(/\{[\s\S]*\}/)?.[0];
  if (!object) return false;
  try {
    return JSON.parse(object).relevant === true;
  } catch {
    return false;
  }
}

export async function evaluateWithCursorSdk(
  input: GroundingAiRelevanceInput
): Promise<boolean> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) return false;
  try {
    const { Agent } = await import('@cursor/sdk');
    const agent = await Agent.create({
      apiKey,
      model: { id: input.modelId },
    });
    try {
      const prompt = [
        'Decide whether the repository-relative changed file paths are relevant to the active run title.',
        'Return JSON only: {"relevant":true} or {"relevant":false}.',
        `Run title: ${JSON.stringify(input.runTitle)}`,
        `Changed paths: ${JSON.stringify(input.changedFiles)}`,
      ].join('\n');
      const run = await agent.send(prompt);
      let output = '';
      if (run.supports('stream')) {
        for await (const event of run.stream()) {
          if (event.type !== 'assistant') continue;
          for (const block of event.message.content) {
            if (block.type === 'text') output += block.text;
          }
        }
      }
      return parseRelevance(output);
    } finally {
      await agent[Symbol.asyncDispose]().catch(() => undefined);
    }
  } catch {
    return false;
  }
}

function emptyVolume(): GroundingNotificationVolume {
  return {
    candidateCount: 0,
    filteredCount: 0,
    aiEvaluatedCount: 0,
    notifiedCount: 0,
    deduplicatedCount: 0,
  };
}

export function createGroundingImpactEvaluatorService(
  dependencies: GroundingImpactEvaluatorDependencies
): GroundingImpactEvaluatorService {
  const resolveModel = dependencies.resolveModel ?? resolveProjectDefaultModel;
  const seenNoticeKeys = new Set<string>();

  const evaluateEnabled = async (
    event: GroundingBranchMovedEvent
  ): Promise<GroundingNotificationVolume> => {
    const changedFiles = filterNoisyChangedFiles(event.changedFiles);
    if (event.fromSha === event.toSha || changedFiles.length === 0) {
      const volume = emptyVolume();
      dependencies.telemetry.notification(
        {
          caller: 'grounding-impact-evaluator',
          project: event.project,
          provider: event.provider,
        },
        volume
      );
      return volume;
    }

    const active = await dependencies.findActiveByRepoBranch({
      provider: event.provider,
      project: event.project,
      repository: event.repository,
      branch: event.branch,
    });
    const volume = emptyVolume();
    volume.candidateCount = active.length;
    const survivors: Array<{
      grounding: RunGrounding;
      context: GroundingRunImpactContext;
      files: string[];
    }> = [];

    for (const grounding of active) {
      if (
        !grounding.isActive ||
        grounding.groundedSha !== event.fromSha ||
        grounding.project !== event.project ||
        grounding.repository !== event.repository ||
        grounding.branch !== event.branch ||
        grounding.provider !== event.provider
      ) {
        volume.filteredCount += 1;
        continue;
      }
      const context = await dependencies.resolveRun(grounding);
      if (!context) {
        volume.filteredCount += 1;
        continue;
      }
      if (
        !(await dependencies.hasProjectAccess(
          context.authorId,
          grounding.project
        ))
      ) {
        volume.filteredCount += 1;
        continue;
      }
      let callerEnabled = false;
      try {
        callerEnabled = await dependencies.isCallerEnabled({
          userId: context.authorId,
          project: grounding.project,
          caller: context.caller,
        });
      } catch {
        callerEnabled = false;
      }
      if (!callerEnabled) {
        volume.filteredCount += 1;
        continue;
      }
      const files = dependencies.heuristicFilter(
        changedFiles,
        grounding,
        context
      );
      if (files.length === 0) {
        volume.filteredCount += 1;
        continue;
      }
      survivors.push({ grounding, context, files });
    }

    if (survivors.length > MAX_AI_CANDIDATES) {
      volume.filteredCount += survivors.length - MAX_AI_CANDIDATES;
    }
    const bounded = survivors.slice(0, MAX_AI_CANDIDATES);
    const modelId = bounded.length ? await resolveModel(event.project) : '';

    for (const candidate of bounded) {
      volume.aiEvaluatedCount += 1;
      const relevant = await dependencies.evaluateAiRelevance({
        run: candidate.grounding,
        runTitle: candidate.context.title,
        changedFiles: candidate.files,
        fromSha: event.fromSha,
        toSha: event.toSha,
        modelId,
      });
      if (!relevant) continue;

      const dedupeKey = groundingImpactDedupeKey(
        candidate.grounding.runId,
        candidate.grounding.groundedSha,
        event.toSha
      );
      if (seenNoticeKeys.has(dedupeKey)) {
        volume.deduplicatedCount += 1;
        continue;
      }
      await dependencies.createNotification(
        candidate.context.authorId,
        {
          type: 'ai',
          title: 'Grounded source changed',
          body: `Source relevant to “${candidate.context.title}” changed. Review the run before re-grounding.`,
          ...(candidate.context.link ? { link: candidate.context.link } : {}),
        },
        { dedupeKey }
      );
      seenNoticeKeys.add(dedupeKey);
      volume.notifiedCount += 1;
    }

    dependencies.telemetry.notification(
      {
        caller: 'grounding-impact-evaluator',
        project: event.project,
        provider: event.provider,
      },
      volume
    );
    return volume;
  };

  const evaluate = async (
    event: GroundingBranchMovedEvent
  ): Promise<GroundingNotificationVolume> => {
    let operationalEnabled = false;
    try {
      operationalEnabled = await dependencies.isOperationalEnabled();
    } catch {
      operationalEnabled = false;
    }

    // @feature-flag:repo-grounding-workspace-profile start winner=enabled
    if (!operationalEnabled) {
      // @feature-flag:repo-grounding-workspace-profile disabled-start
      const disabledResult = emptyVolume();
      // @feature-flag:repo-grounding-workspace-profile disabled-end
      return disabledResult;
    }

    // @feature-flag:repo-grounding-workspace-profile enabled-start
    const result = await evaluateEnabled(event);
    // @feature-flag:repo-grounding-workspace-profile enabled-end
    // @feature-flag:repo-grounding-workspace-profile end
    return result;
  };

  return {
    evaluate,
    enqueue(event) {
      void Promise.resolve()
        .then(() => evaluate(event))
        .catch(() => undefined);
    },
  };
}

export const groundingImpactEvaluatorService =
  createGroundingImpactEvaluatorService({
    findActiveByRepoBranch: (query) =>
      runGroundingService.findActiveByRepoBranch(query),
    resolveRun: resolveProductionRunImpactContext,
    hasProjectAccess: hasPersistedProjectAccess,
    heuristicFilter: defaultGroundingImpactHeuristic,
    evaluateAiRelevance: evaluateWithCursorSdk,
    isOperationalEnabled: () =>
      isFeatureOperational('repo-grounding-workspace-profile'),
    isCallerEnabled: (context) => isGroundingEnabledForCaller(context),
    resolveModel: resolveProjectDefaultModel,
    createNotification,
    telemetry: groundingTelemetry,
  });
