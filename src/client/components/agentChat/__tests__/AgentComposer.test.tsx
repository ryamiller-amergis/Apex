import { fireEvent, render, screen } from '@testing-library/react';
import { AgentComposer } from '../AgentComposer';

describe('AgentComposer', () => {
  it('renders the interview-style stacked shell with send control', () => {
    const onSend = jest.fn();
    render(
      <AgentComposer
        value="hello"
        onChange={jest.fn()}
        onSend={onSend}
        testIdPrefix="demo"
      />,
    );

    expect(screen.getByTestId('demo-message-input')).toHaveValue('hello');
    fireEvent.click(screen.getByTestId('demo-send-btn'));
    expect(onSend).toHaveBeenCalled();
  });

  it('shows stop while running and invokes cancel', () => {
    const onCancel = jest.fn();
    render(
      <AgentComposer
        value=""
        onChange={jest.fn()}
        onSend={jest.fn()}
        onCancel={onCancel}
        isRunning
        testIdPrefix="demo"
      />,
    );

    fireEvent.click(screen.getByTestId('demo-stop-btn'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders attach, mic, and model controls when provided', () => {
    render(
      <AgentComposer
        value=""
        onChange={jest.fn()}
        onSend={jest.fn()}
        onAttachClick={jest.fn()}
        speech={{
          isListening: false,
          isSpeechSupported: true,
          onToggle: jest.fn(),
        }}
        model="composer-2"
        models={[{ id: 'composer-2', displayName: 'Composer 2' }]}
        onModelChange={jest.fn()}
        testIdPrefix="demo"
      />,
    );

    expect(screen.getByTestId('demo-attach')).toBeInTheDocument();
    expect(screen.getByTestId('demo-microphone')).toBeInTheDocument();
    expect(screen.getByTestId('demo-model')).toHaveValue('composer-2');
  });
});
