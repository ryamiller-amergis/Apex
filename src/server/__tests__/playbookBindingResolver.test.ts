import {
  PlaybookBindingError,
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
});
