import { createHash } from 'crypto';
import {
  readBuildPromptBlob,
  storeLocalBuildPromptBlob,
} from '../services/buildAgentLaunchService';
import {
  createSecretValueDetector,
  validateBuildLaunchSnapshot,
} from '../services/buildExecutionSnapshot';
import { buildTaskExecutionPrompt } from '../services/buildOrchestrator/taskCandidateBuilder';
import {
  publicBuildOrchestrationFailureMessage,
  synthesizeFallbackBuildPlan,
} from '../services/buildOrchestrator/planning';
import { validateBuildPlan } from '../services/buildPlanning/planValidator';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('buildOrchestrationFlow & taskCandidateBuilder', () => {
  it('does not expose query text or parameters in a build failure message', () => {
    const error = new Error(
      'Failed query: update "build_revisions" set "plan" = $1\nparams: [{"secret":"value"}]'
    );

    expect(publicBuildOrchestrationFailureMessage(error)).toBe(
      'The repository build agent did not start.'
    );
  });

  it('formats a complete task execution prompt with requirements, risk decisions, owned files, and standards', () => {
    const prompt = buildTaskExecutionPrompt({
      buildRunId: '16dd6dcc-595d-48b8-8da8-1110751a2320',
      revisionNumber: 1,
      classification: 'full',
      integrationBranch: 'apex/build/16dd6dcc-595d-48b8-8da8-1110751a2320',
      targetBranch:
        'apex/build/16dd6dcc-595d-48b8-8da8-1110751a2320/t-impl-1-1',
      taskKey: 't-impl-1',
      role: 'implementer',
      attempt: 1,
      briefPrompt: 'Add a calendar component to the home page',
      ownedFiles: ['apps/web/src/features/calendar/CalendarWidget.tsx'],
      covers: ['AC-1', 'RD-1'],
      requirements: [
        {
          id: 'AC-1',
          kind: 'ac',
          text: 'Renders the monthly calendar view on the home page',
          retired: false,
        },
        {
          id: 'AC-2',
          kind: 'ac',
          text: 'Retired requirement',
          retired: true,
        },
      ],
      riskDecisions: [
        {
          id: 'RD-1',
          category: 'access',
          rating: 'low',
          decision: 'Keep calendar scoped to authenticated principal',
          rationale: 'Matches ADR 0002',
        },
      ],
      reuse: [
        {
          path: 'packages/ui/src/index.ts',
          symbol: 'LoadingState',
          reason: 'Shared loading state component',
        },
      ],
      qualityManifest: {
        typeCheck: 'corepack pnpm typecheck',
        lint: 'corepack pnpm lint',
        relatedTests: 'corepack pnpm vitest related --run {files}',
        unitSuite: 'corepack pnpm test:unit',
      },
      standards: {
        designSystem: {
          path: '.cursor/skills/design-system/SKILL.md',
          contentHash: 'a'.repeat(64),
        },
        codingRules: {
          path: '.cursor/rules/react-mui-express.mdc',
          contentHash: 'b'.repeat(64),
        },
        codeMap: {
          path: '.cursor/CODEMAP.md',
          contentHash: 'c'.repeat(64),
        },
      },
      skillPath: '.cursor/skills/build-implementer/SKILL.md',
      priorAttemptFindings: [
        {
          attemptNumber: 1,
          message: 'The test report omitted a referenced passing test.',
          violations: [
            { code: 'test_not_in_run', requirementId: 'BR-2' },
          ],
          visualFindings: [],
        },
      ],
      previousBranch:
        'apex/build-task/16dd6dcc-595d-48b8-8da8-1110751a2320/r1/implement-widget-1',
    });

    expect(prompt).toContain(
      'Read and follow the skill at `.cursor/skills/build-implementer/SKILL.md`.'
    );
    expect(prompt).toContain(
      'AC-1 (AC): Renders the monthly calendar view on the home page'
    );
    expect(prompt).not.toContain('AC-2');
    expect(prompt).toContain(
      'RD-1 (access, low): Keep calendar scoped to authenticated principal'
    );
    expect(prompt).toContain(
      'apps/web/src/features/calendar/CalendarWidget.tsx'
    );
    expect(prompt).toContain('packages/ui/src/index.ts (LoadingState)');
    expect(prompt).toContain('corepack pnpm typecheck');
    expect(prompt).toContain('apex-evidence');
    expect(prompt).toContain('test_not_in_run (BR-2)');
    expect(prompt).toContain(
      'List every testReferences[].name for this requirement in green.passedTests exactly as written.'
    );
  });

  it('caches and reads local build prompt blobs and validates the snapshot schema', async () => {
    const promptText = 'Implement AC-1 with red and green commits.';
    const pointer = {
      container: 'cursor-prompts',
      key: 'builds/run-local-1/r1/t-impl-1/attempt-1/prompt.txt',
    };
    storeLocalBuildPromptBlob(pointer, promptText);

    const readBack = await readBuildPromptBlob(pointer);
    expect(readBack).toBe(promptText);

    const contextText = '.apex/build/run-local-1/context-notes.md';
    const candidate = {
      schemaVersion: 1 as const,
      buildRunId: 'run-local-1',
      buildRevisionId: 'rev-local-1',
      buildTaskId: 'task-local-1',
      taskKey: 't-impl-1',
      role: 'implementer' as const,
      attempt: 1,
      model: 'composer-2.5',
      skill: {
        path: '.cursor/skills/build-implementer/SKILL.md',
        contentHash: '1'.repeat(64),
      },
      standards: {
        designSystem: {
          path: '.cursor/skills/design-system/SKILL.md',
          contentHash: '2'.repeat(64),
        },
        codingRules: {
          path: '.cursor/rules/react-mui-express.mdc',
          contentHash: '3'.repeat(64),
        },
        codeMap: {
          path: '.cursor/CODEMAP.md',
          contentHash: '4'.repeat(64),
        },
      },
      prompt: {
        container: pointer.container,
        key: pointer.key,
        contentHash: sha256Hex(promptText),
      },
      context: [
        {
          container: pointer.container,
          key: 'builds/run-local-1/r1/context.txt',
          contentHash: sha256Hex(contextText),
          label: 'context-notes',
        },
      ],
      repository: {
        provider: 'ado' as const,
        project: 'Amergis Connect - ATS',
        repo: 'Amergis Connect - ATS',
        defaultBranch: 'main',
      },
      startingBranch: 'apex/build/run-local-1',
      targetBranch: 'apex/build/run-local-1/t-impl-1-1',
      pullRequest: { open: false as const },
      caps: {
        costUsd: 25,
        elapsedMs: 14_400_000,
        revisions: 5,
        parallelism: 4,
      },
      secretRefs: [],
    };

    const validation = validateBuildLaunchSnapshot(candidate, {
      expectedProjectId: 'Amergis Connect - ATS',
      detector: createSecretValueDetector([]),
    });
    expect(validation.ok).toBe(true);
  });

  it('synthesizes a schema-valid fallback BuildPlan covering all active requirements', () => {
    const requirements = [
      {
        id: 'AC-1',
        kind: 'ac' as const,
        text: 'Renders calendar grid',
        retired: false,
      },
      {
        id: 'AC-2',
        kind: 'ac' as const,
        text: 'Supports month navigation',
        retired: false,
      },
    ];
    const plan = synthesizeFallbackBuildPlan(
      '70a4c165-7293-4ec6-b81e-cbea2764c4ca',
      requirements,
      []
    );
    const result = validateBuildPlan({
      plan,
      requirements,
      riskDecisions: [],
      classification: 'small',
    });
    expect(result.ok).toBe(true);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      key: 'build-feature',
      role: 'implementer',
      covers: ['AC-1', 'AC-2'],
    });
  });
});
