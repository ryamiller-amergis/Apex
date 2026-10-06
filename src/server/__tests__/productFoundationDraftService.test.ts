import { ProductFoundationError } from '../services/productSetupService';
import {
  draftProductFoundation,
  productMarkdownFromModel,
  reviseProductFoundation,
  saveProductFoundation,
  type ProductFoundationDeps,
} from '../services/productFoundationDraftService';

const answers = [
  'A shared to-do app for small teams.',
  'They lose tasks in conversation.',
  'Add and assign tasks.',
  'A task has an owner and a status.',
];

function deps(overrides: Partial<ProductFoundationDeps> = {}): ProductFoundationDeps {
  return {
    openSetup: jest.fn().mockResolvedValue({ repoName: 'to-do-app' }),
    complete: jest.fn().mockResolvedValue('# Product Foundation\n\n## Product\nA shared to-do app.\n'),
    writeProduct: jest.fn().mockResolvedValue(undefined),
    now: () => new Date('2026-09-30T18:00:00.000Z'),
    ...overrides,
  };
}

const request = { project: 'To Do App', userId: 'user-1', answeredBy: 'Ryan' };

describe('product foundation drafts', () => {
  it('asks Bedrock for a document from the reviewed answers and unwraps a code fence', async () => {
    const complete = jest.fn().mockResolvedValue('```markdown\n# Product Foundation\n\n## Product\nA shared to-do app.\n```');
    const used = deps({ complete });

    await expect(draftProductFoundation({ ...request, answers }, used)).resolves.toBe(
      '# Product Foundation\n\n## Product\nA shared to-do app.\n',
    );

    const prompt = complete.mock.calls[0][0] as string;
    expect(prompt).toContain('A shared to-do app for small teams.');
    expect(prompt).toContain('Do not add features');
    expect(prompt).toContain('Answered by: Ryan');
    expect(prompt).toContain('Date: 2026-09-30');
    expect(prompt).not.toContain('ask the six questions');
    expect(complete.mock.calls[0][1]).toMatchObject({ feature: 'product-foundation', project: 'To Do App' });
    expect(used.openSetup).toHaveBeenCalledWith('To Do App', 'user-1');
  });

  it('revises the current draft instead of starting the interview over', async () => {
    const complete = jest.fn().mockResolvedValue('# Product Foundation\n\n## Out of scope\nNo mobile app.\n');
    const used = deps({ complete });

    await reviseProductFoundation({
      ...request,
      draft: '# Product Foundation\n\n## Out of scope\nNone specified.\n',
      changes: 'The first release has no mobile app.',
    }, used);

    const prompt = complete.mock.calls[0][0] as string;
    expect(prompt).toContain('Apply only the requested change');
    expect(prompt).toContain('The first release has no mobile app.');
    expect(prompt).toContain('None specified.');
    expect(prompt).not.toContain('Question 1');
  });

  it('writes the approved markdown and does not call the model', async () => {
    const used = deps();
    await saveProductFoundation({
      ...request,
      markdown: '# Product Foundation\n\n## Product\nA shared to-do app.\n',
    }, used);

    expect(used.complete).not.toHaveBeenCalled();
    expect(used.writeProduct).toHaveBeenCalledWith(
      'to-do-app',
      '# Product Foundation\n\n## Product\nA shared to-do app.\n',
    );
  });

  it('does not write when setup is already closed', async () => {
    const used = deps({
      openSetup: jest.fn().mockRejectedValue(new ProductFoundationError('PRODUCT.md is already in the repository.', 409, 'SETUP_CLOSED')),
    });

    await expect(saveProductFoundation({
      ...request,
      markdown: '# Product Foundation\n',
    }, used)).rejects.toMatchObject({ code: 'SETUP_CLOSED' });
    expect(used.writeProduct).not.toHaveBeenCalled();
  });

  it('rejects a model reply that is not a document', () => {
    expect(() => productMarkdownFromModel('What is the product, and who is it for?')).toThrow(ProductFoundationError);
  });
});
