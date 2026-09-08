import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { EventsTable } from '../AiCostAnalytics';
import { useAiCostEvents } from '../../hooks/useAiCostAnalytics';
import type { AiCostEvent } from '../../../shared/types/aiCostAnalytics';

jest.mock('../../hooks/useAiCostAnalytics', () => ({
  useAiCostEvents: jest.fn(),
}));

const mockUseAiCostEvents = useAiCostEvents as jest.MockedFunction<typeof useAiCostEvents>;

function event(id: string, effort: AiCostEvent['effort']): AiCostEvent {
  return {
    id,
    provider: 'cursor',
    modelId: 'composer-2.5',
    effort,
    feature: 'interview',
    project: 'Apex',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokenSource: 'exact',
    costUsd: 0.01,
    costSource: 'computed',
    durationMs: 500,
    status: 'success',
    entityType: 'interview',
    entityId: 'interview-1',
    workItemId: null,
    createdAt: '2026-09-08T00:00:00.000Z',
  };
}

describe('AiCostAnalytics EventsTable effort display', () => {
  it('TBI-006 DoD-3/DoD-4 / VT-11 shows effort when present and leaves null blank', () => {
    mockUseAiCostEvents.mockReturnValue({
      data: {
        events: [event('with-effort', 'low'), event('legacy', null)],
        total: 2,
        page: 1,
        pageSize: 20,
      },
      isLoading: false,
    } as ReturnType<typeof useAiCostEvents>);

    render(<EventsTable filters={{ project: 'Apex' }} />);

    expect(screen.getByRole('columnheader', { name: 'Effort' })).toBeVisible();
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('Low')).toBeVisible();
    expect(within(rows[2]).queryByText(/Low|Medium|High/)).not.toBeInTheDocument();
  });
});
