import fs from 'fs';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads } from '../db/schema';
import type { ValidationScorecard } from '../../shared/types/interview';
import { buildPassingValidationReasonsMarkdown } from '../../shared/utils/validationReport';
import {
  readOutputValidationScorecard,
  readOutputValidationScorecardMd,
  isThreadIdle,
  createThread as createChatThread,
  cancelRun,
  sendMessage,
} from './chatAgentService';
import { getSkillConfig, resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';

const VALIDATION_WATCHER_INTERVAL_MS = 5_000;
const VALIDATION_WATCHER_MAX_ATTEMPTS = 720;

export interface DocumentValidationAdapter {
  getDocumentId(): string;
  getProject(): string;
  getSkillSettingsId?(): string | null;
  getAuthorId(): string;
  getValidationThreadId(): string | null;
  getStatus(): string;
  buildValidationContext(skillConfig: Awaited<ReturnType<typeof getSkillConfig>>): string;
  getSkillPath(skillConfig: NonNullable<Awaited<ReturnType<typeof getSkillConfig>>>): string | null | undefined;
  getModel(skillConfig: NonNullable<Awaited<ReturnType<typeof getSkillConfig>>>, globalModel: string): string;
  updateDbForValidationStart(threadId: string): Promise<void>;
  updateDbForValidationResult(scorecard: ValidationScorecard, reportMd: string): Promise<void>;
  updateDbForValidationTimeout(): Promise<void>;
  updateDbForValidationError(): Promise<void>;
  isCurrentValidationThread(threadId: string): Promise<boolean>;
  onValidationComplete?(scorecard: ValidationScorecard): Promise<void>;
}

const activeValidationWatchers = new Map<string, ReturnType<typeof setInterval>>();

export function stopDocumentValidationWatcher(documentId: string): void {
  const handle = activeValidationWatchers.get(documentId);
  if (handle !== undefined) {
    clearInterval(handle);
    activeValidationWatchers.delete(documentId);
    console.log(`[documentValidationWatcher] Cancelled — documentId=${documentId}`);
  }
}

export function isDocumentValidationWatcherActive(documentId: string): boolean {
  return activeValidationWatchers.has(documentId);
}

async function cleanupWorkspace(threadId: string): Promise<void> {
  try {
    const row = await db.query.chatThreads.findFirst({
      where: eq(chatThreads.id, threadId),
      columns: { workspaceDir: true },
    });
    if (row?.workspaceDir) {
      fs.rmSync(row.workspaceDir, { recursive: true, force: true });
    }
  } catch { /* non-fatal */ }
}

export async function autoStartDocumentValidation(adapter: DocumentValidationAdapter): Promise<void> {
  const project = adapter.getProject();
  const settingsId = adapter.getSkillSettingsId?.() ?? undefined;
  const skillConfig = await resolveSkillConfig({ project, settingsId });
  if (!skillConfig) return;

  const skillPath = adapter.getSkillPath(skillConfig);
  if (!skillPath) return;

  const globalModel = await getDefaultModel();
  const model = adapter.getModel(skillConfig, globalModel);
  const context = adapter.buildValidationContext(skillConfig);

  const thread = await createChatThread(adapter.getAuthorId(), {
    project,
    repo: skillConfig.skillRepo,
    branch: skillConfig.skillBranch ?? 'main',
    skillProvider: skillConfig.skillProvider ?? undefined,
    skillPath,
    freeformContext: context,
    model,
  });

  stopDocumentValidationWatcher(adapter.getDocumentId());
  await adapter.updateDbForValidationStart(thread.id);
  startDocumentValidationWatcher(adapter, thread.id);
}

export function startDocumentValidationWatcher(
  adapter: DocumentValidationAdapter,
  validationThreadId: string,
): void {
  const documentId = adapter.getDocumentId();
  stopDocumentValidationWatcher(documentId);
  let attempts = 0;

  console.log(`[documentValidationWatcher] Started — documentId=${documentId} threadId=${validationThreadId}`);

  const interval = setInterval(async () => {
    attempts += 1;

    if (attempts > VALIDATION_WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activeValidationWatchers.delete(documentId);
      console.warn(`[documentValidationWatcher] Timed out (documentId=${documentId})`);
      await adapter.updateDbForValidationTimeout();
      return;
    }

    const scorecardRaw = readOutputValidationScorecard(validationThreadId);

    if (!scorecardRaw) {
      if (isThreadIdle(validationThreadId)) {
        clearInterval(interval);
        activeValidationWatchers.delete(documentId);
        console.warn(`[documentValidationWatcher] Agent completed without scorecard — resetting (documentId=${documentId})`);
        await adapter.updateDbForValidationError();
      }
      return;
    }

    clearInterval(interval);
    activeValidationWatchers.delete(documentId);

    try {
      const isCurrent = await adapter.isCurrentValidationThread(validationThreadId);
      if (!isCurrent) {
        console.log(`[documentValidationWatcher] Discarded stale result — thread ${validationThreadId} no longer active (documentId=${documentId})`);
        cleanupWorkspace(validationThreadId);
        return;
      }

      const scorecard = JSON.parse(scorecardRaw) as ValidationScorecard;
      const reportMd = readOutputValidationScorecardMd(validationThreadId) ?? generateFallbackReport(scorecard);
      await adapter.updateDbForValidationResult(scorecard, reportMd);
      console.log(`[documentValidationWatcher] Scorecard synced — score=${scorecard.overall_score} is_ready=${scorecard.is_ready} (documentId=${documentId})`);
      cleanupWorkspace(validationThreadId);

      if (adapter.onValidationComplete) {
        await adapter.onValidationComplete(scorecard);
      }
    } catch (err) {
      console.error(`[documentValidationWatcher] Failed to parse/sync scorecard (documentId=${documentId})`, err);
    }
  }, VALIDATION_WATCHER_INTERVAL_MS);

  activeValidationWatchers.set(documentId, interval);
}

export async function cancelDocumentValidation(
  documentId: string,
  validationThreadId: string | null,
): Promise<void> {
  stopDocumentValidationWatcher(documentId);
  if (validationThreadId) {
    cancelRun(validationThreadId).catch((err: Error) => {
      console.warn(`[cancelDocumentValidation] Could not cancel agent run for thread ${validationThreadId}:`, err.message);
    });
  }
}

export function generateFallbackReport(scorecard: ValidationScorecard): string {
  const lines: string[] = [
    `# Validation Report`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Overall Score | **${scorecard.overall_score}%** |`,
    `| Verdict | ${scorecard.verdict.replace(/_/g, ' ')} |`,
    `| Phase | ${scorecard.review_phase} |`,
    `| Ready | ${scorecard.is_ready ? 'Yes' : 'No'} |`,
    '',
  ];

  const passingReasons = buildPassingValidationReasonsMarkdown(scorecard);
  if (passingReasons) {
    lines.push(passingReasons, '');
  }

  if ((scorecard.features ?? []).length > 0) {
    lines.push('## Feature Scores', '');
    lines.push('| Feature | Design | Tech Spec | Assumptions | Overall | Verdict |');
    lines.push('|---------|--------|-----------|-------------|---------|---------|');
    for (const f of scorecard.features!) {
      lines.push(`| ${f.feature_title} | ${f.design_score}% | ${f.tech_spec_score}% | ${f.assumptions_score}% | ${f.overall_score}% | ${f.verdict} |`);
    }
    lines.push('');

    const allGaps = scorecard.features!.flatMap((f) => f.gaps.filter((g) => g.resolution === 'pending'));
    if (allGaps.length > 0) {
      lines.push('## Open Gaps', '');
      for (const gap of allGaps) {
        lines.push(`- **${gap.section}** (${gap.file}): ${gap.description} — Score: ${gap.score}/3`);
      }
      lines.push('');
    }
  }

  const crossCuttingEntries = Object.entries(scorecard.cross_cutting_checks ?? {});
  if (crossCuttingEntries.length > 0) {
    lines.push('## Cross-Cutting Checks', '');
    for (const [check, result] of crossCuttingEntries) {
      lines.push(`- **${check}**: ${result}`);
    }
    lines.push('');
  }

  if ((scorecard.accepted_gaps ?? []).length > 0) {
    lines.push('## Accepted Gaps', '');
    for (const g of scorecard.accepted_gaps!) lines.push(`- ${g}`);
    lines.push('');
  }

  if ((scorecard.deferred_gaps ?? []).length > 0) {
    lines.push('## Deferred Gaps', '');
    for (const g of scorecard.deferred_gaps!) lines.push(`- ${g}`);
    lines.push('');
  }

  return lines.join('\n');
}
