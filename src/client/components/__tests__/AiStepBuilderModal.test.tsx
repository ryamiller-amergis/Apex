/**
 * AiStepBuilderModal — generate one step, accept it, choose a position, and insert.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiStepBuilderModal } from '../AiStepBuilderModal';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div>{children}</div>,
}));
jest.mock('remark-gfm', () => () => {});

const mockGenerate = jest.fn();
const mockValidate = jest.fn();

jest.mock('../../hooks/useWalkthroughAiDraft', () => ({
  useGenerateWalkthroughAiStep: () => ({ mutateAsync: mockGenerate, isPending: false }),
  useValidateWalkthroughAiUnit: () => ({ mutateAsync: mockValidate, isPending: false }),
}));

jest.mock('../../hooks/usePlatformAdminWalkthroughs', () => ({
  useWalkthroughAnchors: () => ({
    data: [
      {
        key: 'user-menu-trigger',
        testId: 'user-menu-trigger',
        label: 'User menu',
        targetRoute: '/home',
        allowedPlacements: ['bottom'],
        smartTags: [],
      },
    ],
    isLoading: false,
  }),
}));

const stepUnit = {
  unitId: 'step-abc',
  kind: 'step' as const,
  value: {
    id: 'abc',
    ordinal: 0,
    heading: 'Open the user menu',
    bodyMarkdown: 'Click your avatar.',
    route: '/home',
    imageUrl: null,
    imageAlt: null,
    anchor: { key: 'user-menu-trigger', targetRoute: '/home', placement: 'bottom' as const },
  },
};

function renderModal(overrides?: { onInsert?: jest.Mock; onClose?: jest.Mock; stepCount?: number }) {
  const onInsert = overrides?.onInsert ?? jest.fn();
  const onClose = overrides?.onClose ?? jest.fn();
  render(
    <AiStepBuilderModal
      projectId="Apex"
      stepCount={overrides?.stepCount ?? 2}
      existingDraft={{ internalName: 'tour', userTitle: 'Tour', whyItMatters: '', steps: [] }}
      onInsert={onInsert}
      onClose={onClose}
    />,
  );
  return { onInsert, onClose };
}

describe('AiStepBuilderModal', () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockValidate.mockReset();
  });

  it('generates, accepts, and inserts a step at the chosen position', async () => {
    mockGenerate.mockResolvedValue({ unit: stepUnit });
    mockValidate.mockResolvedValue({ valid: true, normalizedUnit: stepUnit });
    const user = userEvent.setup();
    const { onInsert, onClose } = renderModal({ stepCount: 2 });

    await user.type(screen.getByTestId('ai-step-intent'), 'Show the user menu');
    await user.click(screen.getByTestId('ai-step-generate'));

    await waitFor(() => expect(screen.getByTestId('ai-step-proposal')).toBeInTheDocument());
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'Apex', intent: 'Show the user menu' }),
    );

    await user.click(screen.getByTestId('ai-step-accept'));
    await waitFor(() => expect(screen.getByTestId('ai-step-position')).toBeInTheDocument());

    // Insert after step 1 (index 1).
    await user.selectOptions(screen.getByTestId('ai-step-position'), '1');
    await user.click(screen.getByTestId('ai-step-insert'));

    expect(onInsert).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ id: 'abc', heading: 'Open the user menu', route: '/home' }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('discards the proposal on reject', async () => {
    mockGenerate.mockResolvedValue({ unit: stepUnit });
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByTestId('ai-step-intent'), 'Show the user menu');
    await user.click(screen.getByTestId('ai-step-generate'));
    await waitFor(() => expect(screen.getByTestId('ai-step-proposal')).toBeInTheDocument());

    await user.click(screen.getByTestId('ai-step-reject'));
    expect(screen.queryByTestId('ai-step-proposal')).not.toBeInTheDocument();
  });

  it('blocks generation when no project target is selected', async () => {
    const user = userEvent.setup();
    render(
      <AiStepBuilderModal
        projectId=""
        stepCount={0}
        existingDraft={{ internalName: '', userTitle: '', whyItMatters: '', steps: [] }}
        onInsert={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    await user.type(screen.getByTestId('ai-step-intent'), 'Something');
    await user.click(screen.getByTestId('ai-step-generate'));
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-step-status')).toHaveTextContent(/project target/i);
  });
});
