import {
  PlaybookBindingError,
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
});
