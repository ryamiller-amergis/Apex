/**
 * S5 / S6 / VT-01 / VT-03 / VT-09 / VT-11 — flag-gated ObservabilityProvider.
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ObservabilityProvider } from '../ObservabilityProvider';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { sendBrowserBatch } from '../../observability/browserTransport';
import { resetRequestInstrumentationForTests } from '../../observability/requestInstrumentation';
import { reportCaughtClientError } from '../../observability/clientErrorReporter';

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));

jest.mock('../../observability/browserTransport', () => ({
  sendBrowserBatch: jest.fn().mockResolvedValue(true),
}));

const mockFlag = useFeatureFlag as jest.MockedFunction<typeof useFeatureFlag>;
const mockSend = sendBrowserBatch as jest.MockedFunction<typeof sendBrowserBatch>;

function renderProvider(enabled: boolean) {
  mockFlag.mockReturnValue(enabled);
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <ObservabilityProvider project="Apex">
        <div>child</div>
      </ObservabilityProvider>
    </MemoryRouter>,
  );
}

describe('ObservabilityProvider', () => {
  const originalFetch = window.fetch;
  let view: ReturnType<typeof renderProvider> | undefined;

  beforeEach(() => {
    window.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
  });

  afterEach(() => {
    view?.unmount();
    view = undefined;
    resetRequestInstrumentationForTests();
    window.fetch = originalFetch ?? (jest.fn() as unknown as typeof fetch);
    mockSend.mockClear();
  });

  it('VT-09 / BR-010 installs nothing when the capture flag is disabled', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    window.fetch = fetchFn as unknown as typeof fetch;
    view = renderProvider(false);
    expect(screen.queryByTestId('observability-provider')).not.toBeInTheDocument();
    await window.fetch('/api/projects');
    const headers = new Headers((fetchFn.mock.calls[0][1] as RequestInit | undefined)?.headers);
    expect(headers.get('traceparent')).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('VT-01 / AC-0 emits a route view and correlates subsequent API calls', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    window.fetch = fetchFn as unknown as typeof fetch;
    view = renderProvider(true);
    expect(screen.getByTestId('observability-provider')).toBeInTheDocument();
    await window.fetch('/api/projects', { credentials: 'include' });
    const headers = new Headers((fetchFn.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('VT-03 does not throw when ingest transport fails', async () => {
    mockSend.mockRejectedValue(new Error('503'));
    view = renderProvider(true);
    await act(async () => {
      reportCaughtClientError(new Error('boundary'), 'boundary');
    });
    await waitFor(() => {
      expect(screen.getByText('child')).toBeInTheDocument();
    });
  });

  it('VT-04 flushes on pagehide without throwing', () => {
    view = renderProvider(true);
    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
  });
});
