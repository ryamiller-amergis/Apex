import type { WalkthroughDefinition } from '../../../shared/types/walkthrough';
import { initialStepIndexForReplay } from '../WalkthroughHelpHost';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('remark-gfm', () => () => {});

const definition: WalkthroughDefinition = {
  id: 'wt-1',
  internalName: 'profile-tour',
  userTitle: 'Profile tour',
  whyItMatters: 'Learn profile settings',
  lifecycle: 'published',
  priority: 1,
  revision: 1,
  publishedAt: '2026-07-29T00:00:00.000Z',
  archivedAt: null,
  createdBy: 'admin',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedBy: 'admin',
  updatedAt: '2026-07-29T00:00:00.000Z',
  targeting: { projects: ['Apex'], groupId: null },
  targetingRules: [{ type: 'project', value: 'Apex' }],
  steps: [
    {
      id: 'step-1',
      walkthroughId: 'wt-1',
      ordinal: 0,
      heading: 'Start',
      bodyMarkdown: 'Start here',
    },
    {
      id: 'step-2',
      walkthroughId: 'wt-1',
      ordinal: 1,
      heading: 'Continue',
      bodyMarkdown: 'Continue here',
    },
    {
      id: 'step-3',
      walkthroughId: 'wt-1',
      ordinal: 2,
      heading: 'Finish',
      bodyMarkdown: 'Finish here',
    },
  ],
};

describe('initialStepIndexForReplay', () => {
  it('restarts a completed walkthrough from step 1', () => {
    expect(
      initialStepIndexForReplay(definition, {
        status: 'completed',
        lastStepId: 'step-3',
      }),
    ).toBe(0);
  });

  it('resumes a dismissed walkthrough from its last step', () => {
    expect(
      initialStepIndexForReplay(definition, {
        status: 'dismissed',
        lastStepId: 'step-2',
      }),
    ).toBe(1);
  });

  it('starts at step 1 when no prior progress exists', () => {
    expect(initialStepIndexForReplay(definition, null)).toBe(0);
  });
});
