import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ObservabilityPoDigestResponse } from '../../../shared/types/observability';
import { buildFallbackPoDigestResponse } from '../../../shared/utils/observabilityPoDigest';
import { ObservabilityWorkspace } from '../ObservabilityWorkspace';

const mockUseObservabilityPoDigest = jest.fn();
const mockUseGenerateObservabilityPoDigest = jest.fn();
const mockUseAvailableModels = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ selectedProject: 'Apex', isSuperAdmin: true }),
}));

jest.mock('../../hooks/useObservabilityQueries', () => ({
  useObservabilityPoDigest: (...args: unknown[]) => mockUseObservabilityPoDigest(...args),
  useGenerateObservabilityPoDigest: (...args: unknown[]) =>
    mockUseGenerateObservabilityPoDigest(...args),
}));

jest.mock('../../hooks/useProjectSkillConfig', () => ({
  useAvailableModels: () => mockUseAvailableModels(),
}));

function digestState(
  window: 'today' | '1d' | '7d' | '14d' | '30d' | '60d' = '7d',
  model = 'composer-2.5',
  effort: 'low' | 'medium' | 'high' = 'medium',
): ObservabilityPoDigestResponse {
  return buildFallbackPoDigestResponse({
    project: 'Apex',
    window,
    model,
    effort,
    now: new Date('2026-11-12T12:00:00.000Z'),
  });
}

describe('ObservabilityWorkspace (Product Owner Digest)', () => {
  const mutateMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAvailableModels.mockReturnValue({
      data: [
        { id: 'composer-2.5', displayName: 'Composer 2.5' },
        { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      ],
      isLoading: false,
      isError: false,
    });
    mockUseObservabilityPoDigest.mockImplementation(
      (_project: string, window: 'today' | '1d' | '7d' | '14d' | '30d' | '60d', model: string, effort: 'low' | 'medium' | 'high') => ({
        data: digestState(window, model, effort),
        isLoading: false,
        isError: false,
        error: null,
        refetch: jest.fn(),
      }),
    );
    mockUseGenerateObservabilityPoDigest.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    });
  });

  it('renders all 6 Product Owner core signals and twice-daily 6 AM / 6 PM schedule status', () => {
    render(<ObservabilityWorkspace project="Apex" />);

    expect(screen.getByTestId('observability-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('observability-schedule-6am')).toHaveTextContent('6:00 AM Daily');
    expect(screen.getByTestId('observability-schedule-6pm')).toHaveTextContent('6:00 PM Daily');

    // Six core PO signals
    expect(screen.getByTestId('observability-signal-top-users')).toHaveTextContent('Top users');
    expect(screen.getByTestId('observability-signal-common-exceptions')).toHaveTextContent(
      'Most common exceptions',
    );
    expect(screen.getByTestId('observability-signal-retention-drops')).toHaveTextContent(
      'Retention dropped per module',
    );
    expect(screen.getByTestId('observability-signal-drop-reasons')).toHaveTextContent(
      'AI summary of why there could be drops',
    );
    expect(screen.getByTestId('observability-signal-top-modules')).toHaveTextContent('Top modules');
    expect(screen.getByTestId('observability-signal-drive-adoption')).toHaveTextContent(
      'AI summary of how we can drive adoption',
    );
  });

  it('supports switching across Today, Last day, Last 7 days, Last 14 days, Last 30 days, and Last 60 days', async () => {
    const user = userEvent.setup();
    render(<ObservabilityWorkspace project="Apex" />);

    const windows: Array<{ key: string; label: string }> = [
      { key: 'today', label: 'Today' },
      { key: '1d', label: 'Last day' },
      { key: '7d', label: 'Last 7 days' },
      { key: '14d', label: 'Last 14 days' },
      { key: '30d', label: 'Last 30 days' },
      { key: '60d', label: 'Last 60 days' },
    ];

    for (const w of windows) {
      const btn = screen.getByTestId(`observability-window-${w.key}`);
      expect(btn).toHaveTextContent(w.label);
      await user.click(btn);
      expect(btn).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('observability-active-model-badge')).toHaveTextContent(w.label);
    }
  });

  it('allows selecting Composer 2.5 and effort level and triggers on-demand digest generation', async () => {
    const user = userEvent.setup();
    render(<ObservabilityWorkspace project="Apex" />);

    const modelSelect = screen.getByTestId('observability-model-select');
    const effortSelect = screen.getByTestId('observability-effort-select');

    await user.selectOptions(modelSelect, 'claude-sonnet-4-6');
    expect(modelSelect).toHaveValue('claude-sonnet-4-6');

    await user.selectOptions(modelSelect, 'composer-2.5');
    expect(modelSelect).toHaveValue('composer-2.5');
    expect(within(modelSelect).getByRole('option', { name: 'Composer 2.5' })).toBeInTheDocument();

    await user.selectOptions(effortSelect, 'high');
    expect(effortSelect).toHaveValue('high');

    await user.click(screen.getByTestId('observability-window-30d'));
    await user.click(screen.getByTestId('observability-generate-digest'));

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        project: 'Apex',
        window: '30d',
        model: 'composer-2.5',
        effort: 'high',
        slot: 'on_demand',
      });
    });

    expect(screen.getByTestId('observability-active-model-badge')).toHaveTextContent(
      'Composer 2.5 (composer-2.5) · High · Last 30 days',
    );
  });

  it('displays an accessible error banner with retry when the digest query fails', async () => {
    const user = userEvent.setup();
    const refetch = jest.fn();
    mockUseObservabilityPoDigest.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { message: 'HTTP 503' },
      refetch,
    });

    render(<ObservabilityWorkspace project="Apex" />);

    expect(screen.getByTestId('observability-po-error')).toHaveTextContent('HTTP 503');
    await user.click(screen.getByTestId('observability-po-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
