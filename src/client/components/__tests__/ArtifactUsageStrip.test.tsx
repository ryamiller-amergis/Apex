import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArtifactUsageStrip } from '../ArtifactUsageStrip';
import type { EntityUsageRollup } from '../../../shared/types/aiCostAnalytics';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const rollup: EntityUsageRollup = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 0,
  totalTokens: 1500,
  costUsd: 0.0123,
  costSource: 'estimated',
  durationMs: 125000,
  interactions: 2,
  models: ['composer-2.5'],
  incomplete: false,
  runs: [
    {
      modelId: 'composer-2.5',
      inputTokens: 1000,
      outputTokens: 200,
      durationMs: 60000,
      costUsd: 0.01,
      createdAt: '2026-09-01T00:00:00.000Z',
    },
    {
      modelId: 'composer-2.5-fast',
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 65000,
      costUsd: 0.0023,
      createdAt: '2026-09-01T00:01:00.000Z',
    },
  ],
};

describe('ArtifactUsageStrip', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not render while generating (visible=false)', () => {
    wrap(<ArtifactUsageStrip endpoint="/api/interviews/1/usage" visible={false} />);
    expect(screen.queryByTestId('artifact-usage-strip')).not.toBeInTheDocument();
  });

  it('hides the strip when the rollup is empty', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...rollup, interactions: 0, totalTokens: 0, runs: [] }),
    }) as unknown as typeof fetch;
    wrap(<ArtifactUsageStrip endpoint="/api/interviews/1/usage" visible />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('artifact-usage-strip')).not.toBeInTheDocument();
  });

  it('renders tokens, time, price, and run count when complete', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => rollup,
    }) as unknown as typeof fetch;
    wrap(<ArtifactUsageStrip endpoint="/api/interviews/1/usage" visible />);
    const strip = await screen.findByTestId('artifact-usage-strip');
    expect(strip).toHaveTextContent('1.5k');
    expect(strip).toHaveTextContent('2m 5s');
    expect(strip).toHaveTextContent('$0.0123');
    expect(strip).toHaveTextContent('2');
    fireEvent.click(screen.getByTestId('artifact-usage-toggle'));
    expect(screen.getByTestId('artifact-usage-runs')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-usage-run-0')).toHaveTextContent('composer-2.5');
  });
});
