import {
  PlaybookBindingError,
  collectStepBindingReferences,
  configHasBindings,
  resolvePlaybookBindings,
} from '../services/playbookBindingResolver';

const context = {
  input: {
    documentId: 'doc-1',
    ownerUserId: 'owner-1',
  },
  steps: {
    score: {
      threadId: 'thread-9',
      scorecard: { is_ready: true },
    },
  },
};

describe('FEAT-014 Playbook binding resolver', () => {
  it('substitutes input and step fields, preserving object values for whole-string placeholders', () => {
    expect(resolvePlaybookBindings({
      documentId: '${input.documentId}',
      validationThreadId: '${steps.score.threadId}',
      scorecard: '${steps.score.scorecard}',
      link: '/backlog/design-doc/${input.documentId}',
    }, context)).toEqual({
      documentId: 'doc-1',
      validationThreadId: 'thread-9',
      scorecard: { is_ready: true },
      link: '/backlog/design-doc/doc-1',
    });
  });

  it('says which step field was missing instead of substituting undefined', () => {
    expect(() => resolvePlaybookBindings('${steps.score.reportMd}', context)).toThrow(
      /did not produce reportMd/,
    );
    expect(() => resolvePlaybookBindings('${steps.missing.title}', context)).toThrow(
      /has no output/,
    );
  });

  it('refuses nested traversal and unknown namespaces', () => {
    expect(() => resolvePlaybookBindings('${input.documentId.id}', context)).toThrow(
      PlaybookBindingError,
    );
    expect(() => resolvePlaybookBindings('${run.documentId}', context)).toThrow(
      PlaybookBindingError,
    );
    expect(() => resolvePlaybookBindings('${steps.score}', context)).toThrow(
      PlaybookBindingError,
    );
  });

  it('leaves leftover ${ in agent text alone and does not treat it as a binding', () => {
    expect(configHasBindings({ reportMd: 'Use ${HOME}' })).toBe(false);
    expect(configHasBindings({ documentId: '${input.documentId}' })).toBe(true);
    expect(resolvePlaybookBindings({
      reportMd: 'Use ${HOME} and keep ${input.documentId}',
    }, context)).toEqual({
      reportMd: 'Use ${HOME} and keep doc-1',
    });
  });

  it('substitutes leftover documented placeholders if the first result is resolved again', () => {
    const once = resolvePlaybookBindings({
      reportMd: '${steps.score.reportMd}',
    }, {
      input: { documentId: 'WRONG' },
      steps: { score: { reportMd: 'Keep ${input.documentId} from the agent' } },
    });
    expect(once).toEqual({ reportMd: 'Keep ${input.documentId} from the agent' });
    expect(configHasBindings(once)).toBe(true);
    expect(resolvePlaybookBindings(once, {
      input: { documentId: 'WRONG' },
      steps: { score: { reportMd: 'Keep ${input.documentId} from the agent' } },
    })).toEqual({ reportMd: 'Keep WRONG from the agent' });
  });

  it('collects only explicit cross-step bindings from nested config', () => {
    expect(collectStepBindingReferences({
      prompt: 'Use ${steps.draft.reportMd} and ${input.documentId}',
      nested: [{ score: '${steps.review.scorecard}' }, '${HOME}'],
    })).toEqual([
      {
        placeholder: '${steps.draft.reportMd}',
        stepId: 'draft',
        field: 'reportMd',
      },
      {
        placeholder: '${steps.review.scorecard}',
        stepId: 'review',
        field: 'scorecard',
      },
    ]);
  });
});
