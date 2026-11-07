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

  it('renders attach, mic, and model controls when provided and opens the model popover menu with icons and subtitles', () => {
    const onModelChange = jest.fn();
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
        models={[
          { id: 'composer-2', displayName: 'Composer 2' },
          { id: 'gemini-4-argon-medium', displayName: 'Gemini 4 Argon Medium' },
        ]}
        onModelChange={onModelChange}
        testIdPrefix="demo"
      />,
    );

    expect(screen.getByTestId('demo-attach')).toBeInTheDocument();
    expect(screen.getByTestId('demo-microphone')).toBeInTheDocument();
    expect(screen.getByTestId('demo-model')).toHaveValue('composer-2');
    expect(screen.getByTestId('demo-model-trigger')).toHaveTextContent('Composer 2');

    fireEvent.click(screen.getByTestId('demo-model-trigger'));
    expect(screen.getByTestId('demo-model-menu')).toBeInTheDocument();
    expect(screen.getByTestId('demo-model-option-composer-2')).toHaveTextContent(
      'Fast multi-step reasoning and codebase synthesis',
    );
    expect(screen.getByTestId('demo-model-option-gemini-4-argon-medium')).toHaveTextContent(
      'Broad context synthesis and multimodal exploration',
    );

    fireEvent.click(screen.getByTestId('demo-model-option-gemini-4-argon-medium'));
    expect(onModelChange).toHaveBeenCalledWith('gemini-4-argon-medium');
    expect(screen.queryByTestId('demo-model-menu')).not.toBeInTheDocument();
  });
});
