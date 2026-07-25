/**
 * FEAT-011 / PBI-014 client — LoadTestAiGeneratePanel
 *
 * AC-0: onApply called with script + suggested_thresholds when generation is ready
 * AC-1: generation error surfaces load-test-ai-error and never calls onApply
 * AC-2: no connected repo renders the unavailable state and hides Generate
 * BR-010: raw script source requires confirm before AI can overwrite it
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseLoadTestAiGenerateResult } from '../../hooks/useLoadTestAiGenerate';
import { LoadTestAiGeneratePanel } from '../LoadTestAiGeneratePanel';

const mockStart = jest.fn();
const mockCancel = jest.fn();
const mockReset = jest.fn();

let mockHookState: UseLoadTestAiGenerateResult;

function baseHookState(): UseLoadTestAiGenerateResult {
  return {
    start: mockStart,
    cancel: mockCancel,
    reset: mockReset,
    status: 'idle',
    streamingText: '',
    progressLabel: null,
    result: null,
    error: null,
    isGenerating: false,
  };
}

jest.mock('../../hooks/useLoadTestAiGenerate', () => ({
  useLoadTestAiGenerate: () => mockHookState,
}));

const PROJECT = 'project-a';

function renderPanel(overrides: Partial<Parameters<typeof LoadTestAiGeneratePanel>[0]> = {}) {
  const onApply = jest.fn();
  render(
    <LoadTestAiGeneratePanel
      project={PROJECT}
      connected
      canManage
      needsConfirm={false}
      onApply={onApply}
      {...overrides}
    />,
  );
  return { onApply };
}

async function fillFlowHints(user: ReturnType<typeof userEvent.setup>, text = 'GET /health') {
  await user.type(screen.getByTestId('load-test-ai-flow-hints'), text);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHookState = baseHookState();
});

describe('LoadTestAiGeneratePanel', () => {
  it('AC-2: no connected repo renders unavailable state and hides Generate', () => {
    renderPanel({ connected: false });

    expect(screen.getByTestId('load-test-ai-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('load-test-ai-generate-btn')).not.toBeInTheDocument();
  });

  it('Generate is disabled until flow hints are provided', () => {
    renderPanel();

    expect(screen.getByTestId('load-test-ai-generate-btn')).toBeDisabled();
  });

  it('Generate is disabled for view-only users', async () => {
    const user = userEvent.setup();
    renderPanel({ canManage: false });
    await fillFlowHints(user);

    expect(screen.getByTestId('load-test-ai-generate-btn')).toBeDisabled();
  });

  it('AC-0: calls onApply with the ready result exactly once', () => {
    mockHookState = {
      ...baseHookState(),
      status: 'ready',
      result: {
        script: "export default function() {}",
        suggested_thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
      },
    };
    const { onApply } = renderPanel();

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({
      script: "export default function() {}",
      suggested_thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
    });
  });

  it('AC-1: renders load-test-ai-error on failure and never calls onApply', () => {
    mockHookState = {
      ...baseHookState(),
      status: 'failed',
      error: 'Agent completed without generating a script.',
    };
    const { onApply } = renderPanel();

    expect(screen.getByTestId('load-test-ai-error')).toHaveTextContent(/agent completed/i);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('clicking Generate starts generation immediately when no confirm is required', async () => {
    const user = userEvent.setup();
    renderPanel({ needsConfirm: false });
    await fillFlowHints(user, 'login then browse');

    await user.click(screen.getByTestId('load-test-ai-generate-btn'));

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        flowHints: 'login then browse',
      }),
    );
    expect(screen.queryByTestId('load-test-ai-regenerate-confirm')).not.toBeInTheDocument();
  });

  it('BR-010: raw script source requires confirm before overwrite; cancelling does not start generation', async () => {
    const user = userEvent.setup();
    renderPanel({ needsConfirm: true });
    await fillFlowHints(user);

    await user.click(screen.getByTestId('load-test-ai-generate-btn'));

    expect(screen.getByTestId('load-test-ai-regenerate-confirm')).toBeInTheDocument();
    expect(mockStart).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByTestId('load-test-ai-regenerate-confirm')).not.toBeInTheDocument();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('BR-010: confirming the overwrite dialog starts generation', async () => {
    const user = userEvent.setup();
    renderPanel({ needsConfirm: true });
    await fillFlowHints(user);

    await user.click(screen.getByTestId('load-test-ai-generate-btn'));
    await user.click(screen.getByRole('button', { name: /generate anyway/i }));

    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('shows Cancel and the streaming preview while generating', () => {
    mockHookState = {
      ...baseHookState(),
      status: 'pending',
      isGenerating: true,
      progressLabel: 'Reading target service…',
      streamingText: 'partial script…',
    };
    renderPanel();

    expect(screen.getByTestId('load-test-ai-cancel-btn')).toBeInTheDocument();
    expect(screen.getByTestId('load-test-ai-stream-preview')).toHaveTextContent(/reading target service/i);
    expect(screen.getByTestId('load-test-ai-generate-btn')).toBeDisabled();
  });

  it('clicking Cancel calls the hook cancel', async () => {
    const user = userEvent.setup();
    mockHookState = {
      ...baseHookState(),
      status: 'pending',
      isGenerating: true,
    };
    renderPanel();

    await user.click(screen.getByTestId('load-test-ai-cancel-btn'));

    expect(mockCancel).toHaveBeenCalledTimes(1);
  });
});
