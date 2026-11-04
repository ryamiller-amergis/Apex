/**
 * Builds a validated `BuildLaunchSnapshot` candidate and stores its assembled
 * prompt for `implementer`, `qa`, and `check` build tasks.
 */
import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import {
  integrationBranchName,
  type BuildQualityManifestSnapshot,
  type BuildRequirement,
  type BuildRiskDecision,
  type BuildSkillSnapshot,
  type BuildTaskRole,
} from '../../../shared/types/build';
import type { BuildLaunchSnapshot } from '../../../shared/types/buildLaunchSnapshot';
import { db } from '../../db/drizzle';
import { buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import {
  BUILD_PROMPT_KEY_PREFIX,
  storeLocalBuildPromptBlob,
} from '../buildAgentLaunchService';
import { CURSOR_PROMPT_CONTAINER } from '../cursorPromptStore';
import type { BuildLaunchCandidateBuilder, BuildTaskLaunchRequest } from './taskLauncher';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface TaskPromptEnvelopeInput {
  buildRunId: string;
  revisionNumber: number;
  classification: 'small' | 'full';
  integrationBranch: string;
  targetBranch: string;
  taskKey: string;
  role: BuildTaskRole;
  attempt: number;
  briefPrompt: string;
  ownedFiles: string[];
  covers: string[];
  requirements: BuildRequirement[];
  riskDecisions: BuildRiskDecision[];
  reuse: Array<{ path: string; symbol?: string; reason?: string }>;
  qualityManifest: BuildQualityManifestSnapshot;
  standards: {
    designSystem: { path: string; contentHash: string };
    codingRules: { path: string; contentHash: string };
    codeMap: { path: string; contentHash: string };
  };
  skillPath: string;
}

export function buildTaskExecutionPrompt(input: TaskPromptEnvelopeInput): string {
  const ownedReqs = input.requirements.filter(
    (r) => !r.retired && (input.covers.length === 0 || input.covers.includes(r.id)),
  );
  const ownedRisks = input.riskDecisions.filter(
    (r) => input.covers.length === 0 || input.covers.includes(r.id),
  );

  const reqLines =
    ownedReqs.length > 0
      ? ownedReqs.map((r) => `- ${r.id} (${r.kind.toUpperCase()}): ${r.text}`).join('\n')
      : '- (Follow task scope from the plan)';

  const riskLines =
    ownedRisks.length > 0
      ? ownedRisks.map((r) => `- ${r.id} (${r.category}, ${r.rating}): ${r.decision} — ${r.rationale}`).join('\n')
      : '- None';

  const ownedFilesLines =
    input.ownedFiles.length > 0
      ? input.ownedFiles.map((f) => `- ${f}`).join('\n')
      : '- (Small path: repository files needed for this feature)';

  const reuseLines =
    input.reuse.length > 0
      ? input.reuse
          .map((r) => `- ${r.path}${r.symbol ? ` (${r.symbol})` : ''}${r.reason ? ` — ${r.reason}` : ''}`)
          .join('\n')
      : '- Search `.cursor/CODEMAP.md` before creating new modules';

  return [
    `Read and follow the skill at \`${input.skillPath}\`.`,
    '',
    '## Task Envelope',
    `- Build Run ID: \`${input.buildRunId}\``,
    `- Revision: \`${input.revisionNumber}\``,
    `- Classification: \`${input.classification}\``,
    `- Task Key: \`${input.taskKey}\``,
    `- Role: \`${input.role}\``,
    `- Attempt Number: \`${input.attempt}\``,
    `- Integration Branch: \`${input.integrationBranch}\``,
    `- Target Task Branch: \`${input.targetBranch}\``,
    `- Plan Path: \`.apex/build/${input.buildRunId}/plan.json\``,
    '',
    '## Feature Request Summary',
    input.briefPrompt,
    '',
    '## Owned Requirements',
    reqLines,
    '',
    '## Owned Risk Decisions',
    riskLines,
    '',
    '## Owned Files',
    ownedFilesLines,
    '',
    '## Reuse Candidates',
    reuseLines,
    '',
    '## Quality Manifest Commands',
    `- typeCheck: \`${input.qualityManifest.typeCheck}\``,
    `- lint: \`${input.qualityManifest.lint}\``,
    `- relatedTests: \`${input.qualityManifest.relatedTests}\``,
    `- unitSuite: \`${input.qualityManifest.unitSuite}\``,
    '',
    '## Frozen Standards Contract',
    `- designSystemFile: \`${input.standards.designSystem.path}\` (sha256: \`${input.standards.designSystem.contentHash}\`)`,
    `- codingRules: \`${input.standards.codingRules.path}\` (sha256: \`${input.standards.codingRules.contentHash}\`)`,
    `- codeMap: \`${input.standards.codeMap.path}\` (sha256: \`${input.standards.codeMap.contentHash}\`)`,
    '',
    'Commit your work to the target branch and end your final message with the required fenced `apex-evidence` JSON block.',
  ].join('\n');
}

function resolveRoleSkill(
  snapshot: BuildSkillSnapshot,
  role: BuildTaskRole,
): { model: string; path: string; contentHash: string } {
  switch (role) {
    case 'qa':
      return {
        model: snapshot.qa.model,
        path: snapshot.qa.skillPath,
        contentHash: snapshot.qa.contentHash,
      };
    case 'check':
    case 'sync':
      return {
        model: snapshot.check.model,
        path: snapshot.check.skillPath,
        contentHash: snapshot.check.contentHash,
      };
    case 'planner':
      return {
        model: snapshot.planner.model,
        path: snapshot.planner.skillPath,
        contentHash: snapshot.planner.contentHash,
      };
    case 'implementer':
    default:
      return {
        model: snapshot.implementer.model,
        path: snapshot.implementer.skillPath,
        contentHash: snapshot.implementer.contentHash,
      };
  }
}

export const buildTaskLaunchCandidate: BuildLaunchCandidateBuilder = async (
  request: BuildTaskLaunchRequest,
) => {
  const headTask = request.tasks[0];
  if (!headTask) {
    return { ok: false, detail: 'No task in launch unit.' };
  }

  const [runRow] = await db
    .select()
    .from(buildRuns)
    .where(eq(buildRuns.id, request.run.id))
    .limit(1);
  if (!runRow) {
    return { ok: false, detail: 'Build run was not found.' };
  }

  const [revRow] = await db
    .select()
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.id, request.run.revisionId),
        eq(buildRevisions.buildRunId, request.run.id),
      ),
    )
    .limit(1);
  if (!revRow) {
    return { ok: false, detail: 'Build revision was not found.' };
  }

  const fullTasks = await db
    .select()
    .from(buildTasks)
    .where(eq(buildTasks.buildRevisionId, revRow.id));
  const taskMap = new Map(fullTasks.map((t) => [t.id, t]));

  const ownedFiles = Array.from(
    new Set(request.tasks.flatMap((t) => taskMap.get(t.id)?.ownedFiles ?? [])),
  );
  const covers = Array.from(
    new Set(request.tasks.flatMap((t) => taskMap.get(t.id)?.covers ?? [])),
  );
  const reuse = request.tasks.flatMap((t) => taskMap.get(t.id)?.reuse ?? []);

  const skillSnapshot = runRow.skillSnapshot;
  const roleSkill = resolveRoleSkill(skillSnapshot, headTask.role);
  const integrationBranch = runRow.integrationBranch ?? integrationBranchName(runRow.id);

  const standards = {
    designSystem: {
      path: skillSnapshot.designSystemFile.path,
      contentHash: skillSnapshot.designSystemFile.hash,
    },
    codingRules: {
      path: skillSnapshot.codingRules.path,
      contentHash: skillSnapshot.codingRules.hash,
    },
    codeMap: {
      path: skillSnapshot.codeMap.path,
      contentHash: skillSnapshot.codeMap.hash,
    },
  };

  const promptText = buildTaskExecutionPrompt({
    buildRunId: runRow.id,
    revisionNumber: revRow.revisionNumber,
    classification: revRow.classification === 'small' ? 'small' : 'full',
    integrationBranch,
    targetBranch: request.branchName,
    taskKey: headTask.key,
    role: headTask.role,
    attempt: request.attempt,
    briefPrompt: runRow.prompt,
    ownedFiles,
    covers,
    requirements: revRow.requirements ?? [],
    riskDecisions: revRow.riskDecisions ?? [],
    reuse,
    qualityManifest: runRow.qualityManifestSnapshot,
    standards,
    skillPath: roleSkill.path,
  });

  const container =
    process.env.CURSOR_PROMPT_BLOB_CONTAINER_NAME?.trim() || CURSOR_PROMPT_CONTAINER;
  const promptKey = `${BUILD_PROMPT_KEY_PREFIX}${runRow.id}/r${revRow.revisionNumber}/${headTask.key}/attempt-${request.attempt}/prompt.txt`;
  const contextKey = `${BUILD_PROMPT_KEY_PREFIX}${runRow.id}/r${revRow.revisionNumber}/context.txt`;

  const promptHash = sha256Hex(promptText);
  const contextText = revRow.contextNotesPath ?? `.apex/build/${runRow.id}/context-notes.md`;
  const contextHash = sha256Hex(contextText);

  storeLocalBuildPromptBlob({ container, key: promptKey }, promptText);
  storeLocalBuildPromptBlob({ container, key: contextKey }, contextText);

  const costUsd = Math.max(1, Number(runRow.costCapUsd) || 25);
  const elapsedMs = Math.max(60_000, (runRow.elapsedCapSeconds || 3600) * 1000);
  const revisions = Math.max(1, runRow.revisionCap || 5);
  const parallelism = Math.min(6, Math.max(1, runRow.parallelismCap || 3));

  const candidate: BuildLaunchSnapshot = {
    schemaVersion: 1,
    buildRunId: runRow.id,
    buildRevisionId: revRow.id,
    buildTaskId: headTask.id,
    taskKey: headTask.key,
    role: headTask.role,
    attempt: request.attempt,
    model: roleSkill.model,
    skill: {
      path: roleSkill.path,
      contentHash: roleSkill.contentHash,
    },
    standards,
    prompt: {
      container,
      key: promptKey,
      contentHash: promptHash,
    },
    context: [
      {
        container,
        key: contextKey,
        contentHash: contextHash,
        label: 'context-notes',
      },
    ],
    repository: {
      provider: 'ado',
      project: runRow.project,
      repo: runRow.repository,
      defaultBranch: 'main',
    },
    startingBranch: integrationBranch,
    targetBranch: request.branchName,
    pullRequest: { open: false },
    caps: {
      costUsd,
      elapsedMs,
      revisions,
      parallelism,
    },
    secretRefs: [],
  };

  return { ok: true, candidate };
};
