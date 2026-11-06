/**
 * Builds a validated `BuildLaunchSnapshot` candidate and stores its assembled
 * prompt for `implementer`, `qa`, and `check` build tasks.
 */
import { createHash } from 'crypto';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import {
  integrationBranchName,
  type BuildQualityManifestSnapshot,
  type BuildRequirement,
  type BuildRiskDecision,
  type BuildSkillSnapshot,
  type BuildTaskRole,
} from '../../../shared/types/build';
import type { BuildLaunchSnapshot } from '../../../shared/types/buildLaunchSnapshot';
import { formatVisualBriefForPrompt, type BuildVisualBrief } from '../../../shared/buildVisualBrief';
import { db } from '../../db/drizzle';
import { agentRuns, buildEvents, buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import {
  BUILD_PROMPT_KEY_PREFIX,
  storeLocalBuildPromptBlob,
} from '../buildAgentLaunchService';
import { CURSOR_PROMPT_CONTAINER } from '../cursorPromptStore';
import type {
  BuildLaunchCandidateBuilder,
  BuildTaskLaunchRequest,
} from './taskLauncher';

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
  visualBriefSection?: string | null;
  priorAttemptFindings?: PriorAttemptFinding[];
  previousBranch?: string | null;
}

export interface PriorAttemptFinding {
  attemptNumber: number;
  message: string;
  violations: Array<{ code: string; requirementId: string | null }>;
  visualFindings: string[];
}

function formatPriorAttemptFindings(
  findings: PriorAttemptFinding[],
  previousBranch: string | null,
  targetBranch: string
): string[] {
  if (findings.length === 0) return [];
  const lines = ['## Prior Attempt Findings (fix these first)'];
  if (previousBranch) {
    lines.push(
      `Your earlier work is on \`${previousBranch}\`. Create \`${targetBranch}\` from it (\`git checkout -b ${targetBranch} ${previousBranch}\` if it is not already checked out) — do not start over.`
    );
  }
  for (const finding of findings) {
    lines.push(`- Attempt ${finding.attemptNumber}: ${finding.message}`);
    for (const v of finding.violations) {
      lines.push(`  - ${v.code}${v.requirementId ? ` (${v.requirementId})` : ''}`);
    }
    for (const visual of finding.visualFindings) {
      lines.push(`  - visual: ${visual}`);
    }
  }
  lines.push(
    'Start from the existing task branch, keep the work that passed, and resolve every item above before emitting evidence.',
    ''
  );
  return lines;
}

export function buildTaskExecutionPrompt(
  input: TaskPromptEnvelopeInput
): string {
  const ownedReqs = input.requirements.filter(
    (r) =>
      !r.retired && (input.covers.length === 0 || input.covers.includes(r.id))
  );
  const ownedRisks = input.riskDecisions.filter(
    (r) => input.covers.length === 0 || input.covers.includes(r.id)
  );

  const reqLines =
    ownedReqs.length > 0
      ? ownedReqs
          .map((r) => `- ${r.id} (${r.kind.toUpperCase()}): ${r.text}`)
          .join('\n')
      : '- (Follow task scope from the plan)';

  const riskLines =
    ownedRisks.length > 0
      ? ownedRisks
          .map(
            (r) =>
              `- ${r.id} (${r.category}, ${r.rating}): ${r.decision} — ${r.rationale}`
          )
          .join('\n')
      : '- None';

  const ownedFilesLines =
    input.ownedFiles.length > 0
      ? input.ownedFiles.map((f) => `- ${f}`).join('\n')
      : '- (Unrestricted: create or edit any repository files needed to deliver the complete end-to-end feature — contracts, database migrations/schema, API routes, and UI screens)';

  const reuseLines =
    input.reuse.length > 0
      ? input.reuse
          .map(
            (r) =>
              `- ${r.path}${r.symbol ? ` (${r.symbol})` : ''}${r.reason ? ` — ${r.reason}` : ''}`
          )
          .join('\n')
      : '- Search `.cursor/CODEMAP.md` before creating new modules';

  return [
    `Read and follow the skill at \`${input.skillPath}\`.`,
    '',
    '## Repository Build',
    'Plan the change internally, then implement the COMPLETE feature end-to-end in this single run (including database migrations/schema, Zod contracts, OpenAPI regeneration, backend API routes, frontend screens, and tests).',
    'NEVER stop after writing red tests, NEVER write a `plan.json` escalation file, and NEVER escalate or defer implementation to another path — you are the full-stack builder for this entire feature.',
    'Push your task branch to `origin` (`git push -u origin <targetBranch>`) immediately after the red test commit, immediately after the green implementation commit, and after any fix commit so your work is preserved on the remote before final checks run.',
    'Do NOT start a live Vite dev server or run `playwright test` in the cloud container (there is no live backend/database for browser e2e in the container, and waiting on Playwright exhausts the container timeout). Verify UI and API behavior with fast Vitest tests (`corepack pnpm test:unit`), and for any Playwright visual snapshot requirement (`DOD-*`), commit the spec file (`apps/web/e2e/*.spec.ts`) and defer e2e execution in `apex-evidence` (`"tier": "e2e"`, `"deferral": { "reason": "Playwright browser snapshots deferred to CI; verified via Vitest component tests." }`, `"red": null`, `"green": null`).',
    'Inspect existing repository patterns and shared components before creating new code.',
    'Add or update automated tests, run the quality commands below, and repair failures before finishing.',
    'Apex will open the pull request after verification; do not open or complete one yourself.',
    '',
    '## Runtime',
    'Cursor cloud machines ship Node 22 and ignore `.nvmrc`. Before any install, type-check, lint, or test command:',
    '1. Read `package.json` `engines.node` and `.nvmrc`.',
    '2. If `node -v` does not satisfy that range, install the required major version and put its `node`, `npm`, and `pnpm` first on `PATH`, ahead of `/exec-daemon`.',
    '3. Install dependencies with the repository package manager.',
    '4. Never lower `engines.node` to silence an engine error.',
    '5. If the required Node version cannot be installed, stop and say which version the repository requires and which version is installed. Do not commit a partial feature.',
    '',
    '## Execution Envelope',
    `- Build Run ID: \`${input.buildRunId}\``,
    `- Revision: \`${input.revisionNumber}\``,
    `- Classification: \`${input.classification}\``,
    `- Task Key: \`${input.taskKey}\``,
    `- Role: \`${input.role}\``,
    `- Attempt Number: \`${input.attempt}\``,
    `- Integration Branch: \`${input.integrationBranch}\``,
    `- Target Task Branch: \`${input.targetBranch}\``,
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
    ...(input.visualBriefSection ? [input.visualBriefSection, ''] : []),
    ...formatPriorAttemptFindings(
      input.priorAttemptFindings ?? [],
      input.previousBranch ?? null,
      input.targetBranch
    ),
    'Commit your work to the target branch and end your final message with the required fenced `apex-evidence` JSON block.',
  ].join('\n');
}

const MAX_PRIOR_ATTEMPTS_IN_PROMPT = 2;

async function loadPriorAttemptFindings(
  buildRunId: string,
  taskKey: string,
  attempt: number
): Promise<PriorAttemptFinding[]> {
  const rows = await db
    .select({ message: buildEvents.message, detail: buildEvents.detail })
    .from(buildEvents)
    .where(
      and(
        eq(buildEvents.buildRunId, buildRunId),
        eq(buildEvents.eventType, 'verification.refused')
      )
    )
    .orderBy(desc(buildEvents.ordinal));

  const findings: PriorAttemptFinding[] = [];
  for (const row of rows) {
    const detail = row.detail ?? {};
    const attemptNumber = Number(detail.attemptNumber);
    if (detail.taskKey !== taskKey || !(attemptNumber < attempt)) continue;
    const violations = Array.isArray(detail.violations)
      ? (detail.violations as Array<{ code?: unknown; requirementId?: unknown }>)
          .filter((v) => typeof v.code === 'string')
          .map((v) => ({
            code: v.code as string,
            requirementId: typeof v.requirementId === 'string' ? v.requirementId : null,
          }))
      : [];
    const visualFindings = Array.isArray(detail.visualFindings)
      ? detail.visualFindings.filter((f): f is string => typeof f === 'string')
      : [];
    findings.push({ attemptNumber, message: row.message, violations, visualFindings });
    if (findings.length >= MAX_PRIOR_ATTEMPTS_IN_PROMPT) break;
  }
  return findings.reverse();
}

async function loadPreviousTaskBranch(buildTaskId: string): Promise<string | null> {
  const [row] = await db
    .select({ branch: agentRuns.cloudBranchName })
    .from(agentRuns)
    .where(and(eq(agentRuns.buildTaskId, buildTaskId), isNotNull(agentRuns.cloudBranchName)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row?.branch ?? null;
}

function resolveRoleSkill(
  snapshot: BuildSkillSnapshot,
  role: BuildTaskRole
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
  request: BuildTaskLaunchRequest
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
        eq(buildRevisions.buildRunId, request.run.id)
      )
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
    new Set(request.tasks.flatMap((t) => taskMap.get(t.id)?.ownedFiles ?? []))
  );
  const covers = Array.from(
    new Set(request.tasks.flatMap((t) => taskMap.get(t.id)?.covers ?? []))
  );
  const reuse = request.tasks.flatMap((t) => taskMap.get(t.id)?.reuse ?? []);

  const skillSnapshot = runRow.skillSnapshot;
  const roleSkill = resolveRoleSkill(skillSnapshot, headTask.role);
  const integrationBranch =
    runRow.integrationBranch ?? integrationBranchName(runRow.id);

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

  const planRecord = revRow.plan as Record<string, unknown> | null;
  const visualBrief = planRecord?.visualBrief as BuildVisualBrief | null;
  const visualBriefSection =
    visualBrief && typeof visualBrief === 'object'
      ? formatVisualBriefForPrompt(visualBrief)
      : null;

  const priorAttemptFindings =
    request.attempt > 1
      ? await loadPriorAttemptFindings(runRow.id, headTask.key, request.attempt)
      : [];
  const previousBranch =
    request.attempt > 1 ? await loadPreviousTaskBranch(headTask.id) : null;

  const promptText = buildTaskExecutionPrompt({
    buildRunId: runRow.id,
    revisionNumber: revRow.revisionNumber,
    classification:
      headTask.key === 'build-feature'
        ? 'full'
        : revRow.classification === 'small'
          ? 'small'
          : 'full',
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
    visualBriefSection,
    priorAttemptFindings,
    previousBranch,
  });

  const container =
    process.env.CURSOR_PROMPT_BLOB_CONTAINER_NAME?.trim() ||
    CURSOR_PROMPT_CONTAINER;
  const promptKey = `${BUILD_PROMPT_KEY_PREFIX}${runRow.id}/r${revRow.revisionNumber}/${headTask.key}/attempt-${request.attempt}/prompt.txt`;
  const contextKey = `${BUILD_PROMPT_KEY_PREFIX}${runRow.id}/r${revRow.revisionNumber}/context.txt`;

  const promptHash = sha256Hex(promptText);
  const contextText =
    revRow.contextNotesPath ?? `.apex/build/${runRow.id}/context-notes.md`;
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
    model: runRow.modelOverride?.trim() || roleSkill.model,
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
