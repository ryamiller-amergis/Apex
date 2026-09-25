import { createHash } from 'node:crypto';
import {
  isAiRunV2DocumentSpecification,
  type AiRunV2DocumentSpecification,
} from '../../../shared/types/aiRunV2DocumentSpec';

function specification(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const skillContent = '# Frozen to-prd skill';
  return {
    workloadLane: 'document',
    prompt: 'Generate the PRD',
    model: 'claude-4',
    effort: null,
    skillPath: '.cursor/skills/to-prd/SKILL.md',
    skillContent,
    skillSha256: createHash('sha256').update(skillContent).digest('hex'),
    workflowClass: 'prd',
    projectId: 'Apex',
    threadId: 'thread-1',
    deadlineMs: 60 * 60_000,
    groundedSha: 'abc123',
    repository: 'apex',
    provider: 'ado',
    scratchInputs: [
      {
        path: '.ai-pilot/kickoff-transcript.md',
        content: '# Interview transcript',
      },
    ],
    ...overrides,
  };
}

describe('V2 document execution specification', () => {
  it('accepts a fully resolved repository-grounded specification', () => {
    const candidate = specification();

    expect(isAiRunV2DocumentSpecification(candidate)).toBe(true);
    if (isAiRunV2DocumentSpecification(candidate)) {
      const typed: AiRunV2DocumentSpecification = candidate;
      expect(typed.deadlineMs).toBe(60 * 60_000);
      expect(typed.effort).toBeNull();
    }
  });

  it.each([
    ['prompt', undefined],
    ['model', undefined],
    ['effort', undefined],
    ['skillPath', undefined],
    ['skillContent', undefined],
    ['skillSha256', undefined],
    ['skillSha256', 'not-a-sha'],
    ['deadlineMs', undefined],
    ['deadlineMs', 0],
    ['groundedSha', undefined],
    ['repository', undefined],
    ['provider', undefined],
    ['scratchInputs', undefined],
  ])('rejects a repository workflow without %s', (field, value) => {
    expect(
      isAiRunV2DocumentSpecification(specification({ [field]: value })),
    ).toBe(false);
  });

  it('accepts an explicit effort and a scratch-only validation specification', () => {
    expect(
      isAiRunV2DocumentSpecification(
        specification({
          effort: 'high',
          workflowClass: 'validation',
          groundedSha: undefined,
          repository: undefined,
          provider: undefined,
          scratchInputs: [
            {
              path: '.ai-pilot/kickoff-context.md',
              content: '# Document',
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('rejects arbitrary scratch files and missing workflow inputs', () => {
    expect(
      isAiRunV2DocumentSpecification(
        specification({
          scratchInputs: [
            {
              path: '.ai-pilot/secret.env',
              content: 'TOKEN=secret',
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isAiRunV2DocumentSpecification(
        specification({
          workflowClass: 'test-cases',
          scratchInputs: [
            {
              path: '.ai-pilot/kickoff-context.md',
              content: '# Test context',
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it.each(['workspaceRef', 'checkoutRef', 'mirrorRef'])(
    'rejects App Service path field %s',
    (field) => {
      expect(
        isAiRunV2DocumentSpecification(
          specification({ [field]: 'C:\\host-only\\path' }),
        ),
      ).toBe(false);
    },
  );
});
