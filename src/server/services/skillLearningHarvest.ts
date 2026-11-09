/**
 * Routes finished `skill-learning` worker runs back to the Skill Learning service that started them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { SKILL_LEARNING_RESULT_FILE } from '../../shared/types/aiRunV2DocumentSpec';
import { applyArtifactJudged, parseArtifactJudgeContext } from './skillArtifactJudge';
import { applyCandidateDrafted, applyCandidateDraftFailed } from './skillExperimentService';
import { parseSkillLearningThreadId } from './skillLearningRuns';
import { applyCheckMiningCompleted, applyCheckMiningFailed, parseCheckMiningContext } from './skillSemanticChecks';

export function ownsSkillLearningThread(threadId: string): boolean {
  return parseSkillLearningThreadId(threadId) !== null;
}

async function readResult(outputDir: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path.join(outputDir, SKILL_LEARNING_RESULT_FILE), 'utf8'));
  } catch {
    return null;
  }
}

async function runHeader(runId: string): Promise<{ project: string | null; context: unknown }> {
  const result = await db.execute(sql`
    SELECT project_id, execution_snapshot->'skillLearningContext' AS context FROM agent_runs WHERE id = ${runId} LIMIT 1
  `);
  const [row] = ((result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])) as Array<{ project_id: string | null; context: unknown }>;
  return { project: row?.project_id ?? null, context: row?.context ?? null };
}

export async function applySkillLearningCompleted(input: { runId: string; threadId: string; outputDir: string }): Promise<void> {
  const parsed = parseSkillLearningThreadId(input.threadId);
  if (!parsed) return;
  const result = await readResult(input.outputDir);
  switch (parsed.task) {
    case 'candidate':
      await applyCandidateDrafted(parsed.subjectKey, result);
      return;
    case 'artifact_judge': {
      const header = await runHeader(input.runId);
      const context = parseArtifactJudgeContext(header.context);
      if (!header.project || !context) {
        console.warn(`[skill-learning] judge run ${input.runId} has no project or context; result dropped`);
        return;
      }
      await applyArtifactJudged(header.project, context, result);
      return;
    }
    case 'check_mining': {
      const header = await runHeader(input.runId);
      const context = parseCheckMiningContext(header.context);
      if (!header.project || !context) {
        await applyCheckMiningFailed(parsed.subjectKey, 'the run has no project or context');
        return;
      }
      await applyCheckMiningCompleted(header.project, context, result);
      return;
    }
    default: {
      const unhandled: never = parsed.task;
      throw new Error(`Unsupported Skill Learning task: ${String(unhandled)}`);
    }
  }
}

export async function applySkillLearningFailed(input: { runId: string; threadId: string; reason: string }): Promise<void> {
  const parsed = parseSkillLearningThreadId(input.threadId);
  if (!parsed) return;
  switch (parsed.task) {
    case 'candidate':
      await applyCandidateDraftFailed(parsed.subjectKey, input.reason);
      return;
    case 'artifact_judge':
      console.warn(`[skill-learning] judge run ${input.runId} failed: ${input.reason}`);
      return;
    case 'check_mining':
      await applyCheckMiningFailed(parsed.subjectKey, input.reason);
      return;
    default: {
      const unhandled: never = parsed.task;
      throw new Error(`Unsupported Skill Learning task: ${String(unhandled)}`);
    }
  }
}
