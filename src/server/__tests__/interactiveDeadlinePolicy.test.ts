import {
  clampInteractiveDeadlinePolicy,
  resolveGroundingPreparationTimeoutMs,
  resolveInteractiveDeadlinePolicy,
} from '../services/interactiveDeadlinePolicy';

describe('interactive deadline policy', () => {
  it('freezes existing configured deadlines without class or model constants', () => {
    const policy = resolveInteractiveDeadlinePolicy(
      {
        interactiveClass: 'agentic',
        requiresRepositoryPreparation: true,
      },
      {
        resolveFirstEventMs: () => 47_001,
        resolveToolCallMs: () => 63_002,
        resolveRepositoryPreparationMs: () => 119_003,
      },
    );

    expect(policy).toEqual({
      absoluteTurnMs: 1_200_000,
      repositoryPreparationMs: 119_003,
      firstEventMs: 47_001,
      toolCallMs: 63_002,
    });
  });

  it('uses the fast absolute bound and omits repository preparation for plain chat', () => {
    const resolveRepositoryPreparationMs = jest.fn(() => 119_003);

    expect(
      resolveInteractiveDeadlinePolicy(
        {
          interactiveClass: 'fast',
          requiresRepositoryPreparation: false,
        },
        {
          resolveFirstEventMs: () => 47_001,
          resolveToolCallMs: () => 63_002,
          resolveRepositoryPreparationMs,
        },
      ),
    ).toEqual({
      absoluteTurnMs: 300_000,
      repositoryPreparationMs: null,
      firstEventMs: 47_001,
      toolCallMs: 63_002,
    });
    expect(resolveRepositoryPreparationMs).not.toHaveBeenCalled();
  });

  it('preserves the existing two-minute grounding preparation source', () => {
    expect(resolveGroundingPreparationTimeoutMs()).toBe(2 * 60 * 1000);
  });

  it('clamps every effective sub-deadline to remaining absolute time', () => {
    const resolved = {
      absoluteTurnMs: 1_200_000 as const,
      repositoryPreparationMs: 119_003,
      firstEventMs: 47_001,
      toolCallMs: 63_002,
    };

    expect(clampInteractiveDeadlinePolicy(resolved, 9_000)).toEqual({
      repositoryPreparationMs: 9_000,
      firstEventMs: 9_000,
      toolCallMs: 9_000,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects invalid remaining absolute time %s',
    (remainingAbsoluteMs) => {
      expect(() =>
        clampInteractiveDeadlinePolicy(
          {
            absoluteTurnMs: 300_000,
            repositoryPreparationMs: null,
            firstEventMs: 47_001,
            toolCallMs: 63_002,
          },
          remainingAbsoluteMs,
        ),
      ).toThrow(/remainingAbsoluteMs/);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects invalid configured deadline %s',
    (value) => {
      expect(() =>
        resolveInteractiveDeadlinePolicy(
          {
            interactiveClass: 'agentic',
            requiresRepositoryPreparation: true,
          },
          {
            resolveFirstEventMs: () => value,
            resolveToolCallMs: () => 10,
            resolveRepositoryPreparationMs: () => 10,
          },
        ),
      ).toThrow(/firstEventMs/);
    },
  );
});
