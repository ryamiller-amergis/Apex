import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentMessage } from '../AgentMessage';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../ReadAloudButton', () => ({
  ReadAloudButton: () => <button aria-label="Read aloud" />,
}));

describe('AgentMessage', () => {
  it('renders plain markdown text', () => {
    render(<AgentMessage text="Hello, this is a test." />);
    expect(screen.getByText('Hello, this is a test.')).toBeInTheDocument();
  });

  it('renders choice blocks with options', () => {
    const text = 'Pick one:\n\na. First option\nb. Second option';
    render(<AgentMessage text={text} onChoiceSubmit={jest.fn()} />);
    expect(screen.getByText('First option')).toBeInTheDocument();
    expect(screen.getByText('Second option')).toBeInTheDocument();
  });

  it('calls onChoiceSubmit when choices are submitted', () => {
    const onSubmit = jest.fn();
    const text = 'Pick one:\n\na. First option\nb. Second option';
    render(<AgentMessage text={text} onChoiceSubmit={onSubmit} />);

    // Select option A
    fireEvent.click(screen.getByText('First option'));
    // Click submit
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/i }));

    expect(onSubmit).toHaveBeenCalledWith(expect.stringContaining('A'));
  });

  it('does not render submit button when locked', () => {
    const text = 'Pick one:\n\na. First option\nb. Second option';
    render(<AgentMessage text={text} onChoiceSubmit={jest.fn()} locked />);
    expect(screen.queryByRole('button', { name: /Submit answers/i })).not.toBeInTheDocument();
  });

  it('does not render submit button when interactive is false', () => {
    const text = 'Pick one:\n\na. First option\nb. Second option';
    render(<AgentMessage text={text} onChoiceSubmit={jest.fn()} interactive={false} />);
    expect(screen.queryByRole('button', { name: /Submit answers/i })).not.toBeInTheDocument();
  });

  it('shows "Answers sent" when alreadyAnswered is true', () => {
    const text = 'Pick one:\n\na. First option\nb. Second option';
    render(<AgentMessage text={text} onChoiceSubmit={jest.fn()} alreadyAnswered />);
    expect(screen.getByText('✓ Answers sent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit answers/i })).not.toBeInTheDocument();
  });

  it('applies highlighted class when highlighted prop is true', () => {
    const { container } = render(
      <AgentMessage text="Hello" highlighted messageId="msg-1" />,
    );
    const bubble = container.querySelector('[data-message-id="msg-1"]');
    expect(bubble?.className).toContain('agentBubbleHighlighted');
  });

  it('shows read aloud button by default', () => {
    render(<AgentMessage text="Hello" />);
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeInTheDocument();
  });

  it('hides read aloud button when showReadAloud is false', () => {
    render(<AgentMessage text="Hello" showReadAloud={false} />);
    expect(screen.queryByRole('button', { name: 'Read aloud' })).not.toBeInTheDocument();
  });
});
