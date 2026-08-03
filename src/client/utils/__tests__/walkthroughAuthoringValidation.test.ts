import {
  createEmptyStep,
  draftFormToCreateCommand,
  stepFormToInput,
  type WalkthroughDraftFormValues,
  type WalkthroughStepFormValues,
} from '../walkthroughAuthoringValidation';

describe('stepFormToInput', () => {
  it('carries imageAlt through to the output', () => {
    const step: WalkthroughStepFormValues = {
      ...createEmptyStep(0),
      heading: 'Welcome',
      imageUrl: '/brand-lockup.svg',
      imageAlt: 'Apex logo',
    };
    const result = stepFormToInput(step, 0);
    expect(result.imageAlt).toBe('Apex logo');
    expect(result.imageUrl).toBe('/brand-lockup.svg');
  });

  it('returns null imageAlt when alt text is blank', () => {
    const step: WalkthroughStepFormValues = {
      ...createEmptyStep(0),
      heading: 'Step',
      imageUrl: '/img.png',
      imageAlt: '  ',
    };
    const result = stepFormToInput(step, 0);
    expect(result.imageAlt).toBeNull();
  });

  it('returns null imageAlt when imageUrl is blank', () => {
    const step: WalkthroughStepFormValues = {
      ...createEmptyStep(0),
      heading: 'Step',
      imageUrl: '',
      imageAlt: 'Some alt',
    };
    const result = stepFormToInput(step, 0);
    expect(result.imageUrl).toBeNull();
    expect(result.imageAlt).toBe('Some alt');
  });
});

describe('draftFormToCreateCommand', () => {
  it('preserves imageAlt for all steps', () => {
    const form: WalkthroughDraftFormValues = {
      internalName: 'Test',
      userTitle: 'Title',
      whyItMatters: 'Reason',
      priority: 0,
      isRequired: false,
      projects: ['Apex'],
      groupId: null,
      steps: [
        {
          ...createEmptyStep(0),
          heading: 'One',
          imageUrl: '/brand-lockup.svg',
          imageAlt: 'Apex logo',
        },
        {
          ...createEmptyStep(1),
          heading: 'Two',
          imageUrl: '/other.png',
          imageAlt: 'Custom image',
        },
      ],
    };
    const command = draftFormToCreateCommand(form);
    expect(command.steps[0].imageAlt).toBe('Apex logo');
    expect(command.steps[1].imageAlt).toBe('Custom image');
  });
});

describe('createEmptyStep', () => {
  it('initializes imageAlt as empty string', () => {
    const step = createEmptyStep(0);
    expect(step.imageAlt).toBe('');
    expect(step.imageUrl).toBeNull();
  });
});
