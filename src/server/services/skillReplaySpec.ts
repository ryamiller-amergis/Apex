/**
 * Builds replay specifications for Skill experiments and reads what a replay produced.
 *
 * A replay is the original V2 run's frozen specification with only the SKILL.md swapped, so the
 * prompt, inputs, model, effort and pinned commit stay the same and any difference comes from the
 * Skill. Replays run on their own thread ids, which the harvest uses to send output to the experiment
 * instead of to the real document.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isAiRunV2DocumentSpecification,
  type AiRunV2DocumentSpecification,
} from '../../shared/types/aiRunV2DocumentSpec';
import type { ReplayOutput, SkillExperimentSubjectType } from '../../shared/types/skillExperiment';

const REPLAY_THREAD_PREFIX = 'skill-replay:';

export type ReplayStage = 'generate' | 'judge';

export function replayThreadId(runId: string, stage: ReplayStage): string {
  return `${REPLAY_THREAD_PREFIX}${runId}:${stage}`;
}

export function parseReplayThreadId(threadId: string): { runId: string; stage: ReplayStage } | null {
  if (!threadId.startsWith(REPLAY_THREAD_PREFIX)) return null;
  const [runId, stage, ...rest] = threadId.slice(REPLAY_THREAD_PREFIX.length).split(':');
  if (!runId || rest.length > 0 || (stage !== 'generate' && stage !== 'judge')) return null;
  return { runId, stage };
}

export function skillContentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const WORKFLOW_FOR_SUBJECT: Record<SkillExperimentSubjectType, AiRunV2DocumentSpecification['workflowClass']> = {
  prd: 'prd',
  design_doc: 'design-doc',
};

export function workflowClassForSubject(subjectType: SkillExperimentSubjectType): AiRunV2DocumentSpecification['workflowClass'] {
  return WORKFLOW_FOR_SUBJECT[subjectType];
}

export class SkillReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillReplayError';
  }
}

/** The original run's specification with the Skill swapped. Throws when the original cannot be replayed. */
export function buildReplayGenerationSpec(
  original: unknown,
  input: Readonly<{ subjectType: SkillExperimentSubjectType; skillContent: string; threadId: string }>,
): AiRunV2DocumentSpecification {
  if (!isAiRunV2DocumentSpecification(original)) {
    throw new SkillReplayError('The original run has no complete V2 specification to replay.');
  }
  if (original.workflowClass !== workflowClassForSubject(input.subjectType)) {
    throw new SkillReplayError(`The original run is a ${original.workflowClass} run, not ${input.subjectType}.`);
  }
  if (!input.skillContent.trim()) throw new SkillReplayError('The Skill text is empty.');
  const candidate: AiRunV2DocumentSpecification = {
    ...original,
    skillContent: input.skillContent,
    skillSha256: skillContentSha256(input.skillContent),
    threadId: input.threadId,
  };
  if (!isAiRunV2DocumentSpecification(candidate)) {
    throw new SkillReplayError('The replay specification failed validation.');
  }
  return candidate;
}

async function listFiles(dir: string, depth = 0): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 1) files.push(...await listFiles(full, depth + 1));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function readFirst(files: readonly string[], pattern: RegExp): Promise<string | null> {
  const match = files.find((file) => pattern.test(path.basename(file)));
  return match ? fs.readFile(match, 'utf8') : null;
}

/** Reads the replay's output directory. Returns null when the run wrote nothing usable. */
export async function readReplayOutput(
  subjectType: SkillExperimentSubjectType,
  outputDir: string,
): Promise<ReplayOutput | null> {
  const files = await listFiles(outputDir);
  switch (subjectType) {
    case 'prd': {
      const markdown = await readFirst(files, /^(PRD\.md|.+\.prd\.md)$/i);
      if (!markdown?.trim()) return null;
      const backlogRaw = await readFirst(files, /\.backlog\.json$/i);
      let backlog: unknown = null;
      if (backlogRaw) {
        try {
          backlog = JSON.parse(backlogRaw);
        } catch {
          backlog = null;
        }
      }
      return { kind: 'prd', markdown, backlog };
    }
    case 'design_doc': {
      const designContent = (await readFirst(files, /[-.]design\.md$/i)) ?? '';
      const techSpecContent = (await readFirst(files, /[-.]tech-spec\.md$/i)) ?? '';
      const assumptionsContent = (await readFirst(files, /[-.]assumptions\.md$/i)) ?? '';
      if (!designContent.trim() && !techSpecContent.trim()) return null;
      return { kind: 'design_doc', designContent, techSpecContent, assumptionsContent };
    }
    default: {
      const unhandled: never = subjectType;
      throw new Error(`Unsupported replay subject: ${String(unhandled)}`);
    }
  }
}
