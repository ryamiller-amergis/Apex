import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ProductSetup, splitFoundationReply } from '../ProductSetup';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div>,
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const base = {
  candidates: [{ userId: 'user-2', displayName: 'Ada', email: 'ada@example.com' }],
  adding: false,
  error: null,
  onAddEmail: jest.fn(),
  onAddExisting: jest.fn(),
  onSkip: jest.fn(),
  onContinue: jest.fn(),
  onChooseStep: jest.fn(),
  onCompleteFoundation: jest.fn(),
};

describe('ProductSetup', () => {
  beforeEach(() => jest.clearAllMocks());

  it('adds a typed email and can skip to the chat step', () => {
    const onAddEmail = jest.fn();
    const onSkip = jest.fn();
    const onChooseStep = jest.fn();
    render(
      <ProductSetup
        {...base}
        step="people"
        onAddEmail={onAddEmail}
        onSkip={onSkip}
        onChooseStep={onChooseStep}
      />,
    );

    fireEvent.change(screen.getByTestId('product-setup-email'), { target: { value: 'new.person@example.com, other@example.com' } });
    fireEvent.click(screen.getByTestId('product-setup-add-email'));
    expect(onAddEmail).toHaveBeenCalledWith('new.person@example.com');
    expect(onAddEmail).toHaveBeenCalledWith('other@example.com');

    fireEvent.click(screen.getByTestId('product-setup-skip'));
    expect(onSkip).toHaveBeenCalled();

    expect(screen.getByTestId('product-setup-step-1')).toHaveTextContent('Add people');
    expect(screen.getByTestId('product-setup-step-2')).toHaveTextContent('Review product foundation');
    fireEvent.click(screen.getByTestId('product-setup-step-2'));
    expect(onChooseStep).toHaveBeenCalledWith('chat');
  });

  it('flags an email that already belongs to someone in Apex', () => {
    const onAddEmail = jest.fn();
    render(
      <ProductSetup
        {...base}
        step="people"
        onAddEmail={onAddEmail}
      />,
    );

    fireEvent.change(screen.getByTestId('product-setup-email'), {
      target: { value: 'ada@example.com, new.person@example.com' },
    });
    expect(screen.getByTestId('product-setup-known-email')).toHaveTextContent('Ada (ada@example.com) is already in Apex');

    fireEvent.click(screen.getByTestId('product-setup-add-email'));
    expect(onAddEmail).toHaveBeenCalledTimes(1);
    expect(onAddEmail).toHaveBeenCalledWith('new.person@example.com');
    expect(screen.getByTestId('product-setup-person-user-2')).toBeChecked();
  });

  it('shows only the foundation step to a viewer who cannot add teammates', () => {
    render(<ProductSetup {...base} step="chat" canInviteTeammates={false} />);
    expect(screen.getByTestId('product-setup-step-1')).toHaveTextContent('Review product foundation');
    expect(screen.queryByTestId('product-setup-step-2')).not.toBeInTheDocument();
    expect(screen.queryByText('Add people')).not.toBeInTheDocument();
    expect(screen.getByText('Review your product foundation')).toBeInTheDocument();
  });

  it('shows a four-part foundation review on step 2', () => {
    render(<ProductSetup {...base} step="chat" />);
    expect(screen.getByText('Review your product foundation')).toBeInTheDocument();
    expect(screen.getByLabelText('Question 1 of 4')).toBeInTheDocument();
    expect(screen.getByText(/describe the product and who it is for/i)).toBeInTheDocument();
  });

  it('collects four answers before requesting one product draft', () => {
    const onCompleteFoundation = jest.fn();
    render(
      <ProductSetup
        {...base}
        step="chat"
        onCompleteFoundation={onCompleteFoundation}
      />,
    );

    for (let index = 0; index < 4; index += 1) {
      fireEvent.change(screen.getByTestId('product-setup-foundation-answer'), {
        target: { value: `Answer ${index + 1}` },
      });
      fireEvent.click(screen.getByTestId('product-setup-foundation-next'));
    }

    expect(onCompleteFoundation).toHaveBeenCalledWith([
      'Answer 1',
      'Answer 2',
      'Answer 3',
      'Answer 4',
    ]);
  });

  it('starts at the beginning so prefilled intake answers can be reviewed', () => {
    render(
      <ProductSetup
        {...base}
        step="chat"
        initialFoundationAnswers={[
          'A shared to-do app for small teams.',
          'Tasks get lost in conversation.',
          '- Add tasks',
          '',
        ]}
      />,
    );

    expect(screen.getByLabelText('Question 1 of 4')).toBeInTheDocument();
    expect(screen.getByTestId('product-setup-foundation-answer')).toHaveValue(
      'A shared to-do app for small teams.',
    );
  });

  it('renders a fenced draft as formatted Markdown with review actions', () => {
    const onConfirmDraft = jest.fn();
    const onReviseDraft = jest.fn();
    render(
      <ProductSetup
        {...base}
        step="chat"
        conversationStarted
        review={{
          reply: 'Here is the draft:\n\n```markdown\n# Product Foundation\n\n## Product\nA shared to-do app.\n\n## In scope\n- Add tasks\n```\n\nPlease confirm or correct the draft:\n\na. Confirm\nb. Correct',
          error: null,
          progressLabel: null,
        }}
        onConfirmDraft={onConfirmDraft}
        onReviseDraft={onReviseDraft}
      />,
    );

    expect(screen.getByTestId('product-setup-chat-ready')).toHaveTextContent('Review your product draft');
    expect(screen.getByTestId('markdown').textContent).toBe(
      '# Product Foundation\n\n## Product\nA shared to-do app.\n\n## In scope\n- Add tasks',
    );

    fireEvent.click(screen.getByTestId('product-setup-request-changes'));
    fireEvent.change(screen.getByTestId('product-setup-changes'), { target: { value: 'Add a mobile app to out of scope' } });
    fireEvent.click(screen.getByTestId('product-setup-send-changes'));
    expect(onReviseDraft).toHaveBeenCalledWith('Add a mobile app to out of scope');

    fireEvent.click(screen.getByTestId('product-setup-confirm-draft'));
    expect(onConfirmDraft).toHaveBeenCalled();
  });

  it('shows progress while the draft is being created', () => {
    render(
      <ProductSetup
        {...base}
        step="chat"
        conversationStarted
        creatingDraft
        review={{ reply: null, error: null, progressLabel: 'Reading PRODUCT.md' }}
      />,
    );
    expect(screen.getByTestId('product-setup-chat-ready')).toHaveTextContent('Creating your product draft');
    expect(screen.getByTestId('product-setup-chat-ready')).toHaveTextContent('Reading PRODUCT.md');
    expect(screen.queryByTestId('product-setup-confirm-draft')).not.toBeInTheDocument();
  });

  it('splits an unfenced draft from the confirmation prompt', () => {
    expect(splitFoundationReply('## Product\nA to-do app.\n\nPlease confirm or correct it.')).toEqual({
      draft: '## Product\nA to-do app.',
      note: null,
    });
    expect(splitFoundationReply('> Auto routed to Grok\n\nWrote PRODUCT.md.')).toEqual({
      draft: null,
      note: 'Wrote PRODUCT.md.',
    });
  });

  it('offers a way back to the conversation once it has started', () => {
    render(<ProductSetup {...base} step="people" conversationStarted />);
    expect(screen.queryByTestId('product-setup-skip')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('product-setup-continue'));
    expect(base.onContinue).toHaveBeenCalled();
    expect(screen.getByTestId('product-setup-continue')).toHaveTextContent('Back to the conversation');
  });
});
