import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ChatMessage } from '../../../../shared/types/chat';
import { AssistantConversation } from '../AssistantConversation';
import type { AssistantConversationProps } from '../AssistantConversation';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../ReadAloudButton', () => ({
  ReadAloudButton: () => <button aria-label="Read aloud" />,
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

const agentReply: ChatMessage = {
  id: 'm-2',
  role: 'agent',
  text: 'The PRD has two open comments.',
  ts: '2026-11-02T21:00:00.000Z',
};

function renderConversation(overrides: Partial<AssistantConversationProps> = {}) {
  const props: AssistantConversationProps = {
    messages: [],
    streamingText: '',
    isWorking: false,
    progressLabel: null,
    progressPhase: null,
    toolProgress: [],
    welcome: {
      title: 'Ask about this PRD',
      description: 'Apex can answer questions about this PRD.',
      suggestions: ['Summarize the open review comments', 'Add a test case for a PBI'],
      onSuggestion: jest.fn(),
    },
    testIdPrefix: 'prd-assistant',
    ...overrides,
  };
  return { props, ...render(<AssistantConversation {...props} />) };
}

describe('AssistantConversation', () => {
  it('shows the welcome and suggested prompts before the first turn', () => {
    renderConversation();
    expect(screen.getByRole('heading', { name: 'Ask about this PRD' })).toBeInTheDocument();
    expect(screen.getAllByTestId('prd-assistant-suggestion')).toHaveLength(2);
  });

  it('passes a suggestion to onSuggestion instead of sending it', () => {
    const { props } = renderConversation();
    fireEvent.click(screen.getByRole('button', { name: 'Add a test case for a PBI' }));
    expect(props.welcome?.onSuggestion).toHaveBeenCalledWith('Add a test case for a PBI');
  });

  it('hides the welcome once the conversation has messages', () => {
    renderConversation({ messages: [agentReply] });
    expect(screen.queryByTestId('prd-assistant-welcome')).not.toBeInTheDocument();
    expect(screen.getByText('The PRD has two open comments.')).toBeInTheDocument();
  });

  it('shows the starting step while the thread is created', () => {
    renderConversation({ isStarting: true });
    expect(screen.getByTestId('prd-assistant-starting')).toHaveTextContent('Starting assistant…');
    expect(screen.queryByTestId('prd-assistant-welcome')).not.toBeInTheDocument();
  });

  it('shows the run step instead of typing dots while the agent works', () => {
    renderConversation({ isWorking: true, progressLabel: 'Planning…', progressPhase: 'planning' });
    expect(screen.getByTestId('prd-assistant-progress')).toHaveTextContent('Planning…');
  });

  it('shows Queued while the turn waits for a worker', () => {
    renderConversation({ isWorking: true, progressPhase: 'queued' });
    expect(screen.getByTestId('prd-assistant-progress')).toHaveTextContent('Queued');
  });

  it('renders agent choice lists without submit buttons', () => {
    renderConversation({
      messages: [{ ...agentReply, text: 'Pick one:\n\na. First option\nb. Second option' }],
    });
    expect(screen.queryByTestId('agent-choice-submit-btn')).not.toBeInTheDocument();
  });

  it('offers Try again on a trailing error and calls onRetry', () => {
    const onRetry = jest.fn();
    renderConversation({
      onRetry,
      messages: [{
        id: 'e-1',
        role: 'system',
        text: 'Error: Interactive agent stopped responding. Please retry.',
        ts: '2026-11-02T21:01:00.000Z',
      }],
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Interactive agent stopped responding');
    fireEvent.click(screen.getByTestId('prd-assistant-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides Try again while a turn is running or when the error is not last', () => {
    const error: ChatMessage = {
      id: 'e-1',
      role: 'system',
      text: 'Error: Worker failed',
      ts: '2026-11-02T21:01:00.000Z',
    };
    const { rerender, props } = renderConversation({ onRetry: jest.fn(), messages: [error], isWorking: true });
    expect(screen.queryByTestId('prd-assistant-retry')).not.toBeInTheDocument();

    rerender(<AssistantConversation {...props} isWorking={false} messages={[error, agentReply]} />);
    expect(screen.queryByTestId('prd-assistant-retry')).not.toBeInTheDocument();
  });
});
