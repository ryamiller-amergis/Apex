import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiExperienceResponse } from '../../../shared/types/aiExperience';
import { AiExperienceDashboard } from '../AiExperienceDashboard';

const mockUseObservabilityAiExperience = jest.fn();

jest.mock('../../hooks/useObservabilityQueries', () => ({
  useObservabilityAiExperience: (...args: unknown[]) => mockUseObservabilityAiExperience(...args),
}));

// ResponsiveContainer needs a non-zero box in jsdom to render children cleanly.
jest.mock('recharts', () => {
  const actual = jest.requireActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 640, height: 240 }}>{children}</div>
    ),
  };
});

function samplePayload(overrides: Partial<AiExperienceResponse> = {}): AiExperienceResponse {
  return {
    window: '120d',
    windowLabel: 'Last 4 months',
    granularity: 'month',
    project: null,
    availableProjects: ['Apex', 'MaxView'],
    fromIso: '2026-07-19T00:00:00.000Z',
    toIso: '2026-11-19T00:00:00.000Z',
    generatedAt: '2026-11-19T00:00:00.000Z',
    headline: {
      conversationalMedianSec: 24.5,
      conversationalTurns: 500,
      generationMedianSec: 150,
      generationRuns: 24,
      successRatePct: 95.8,
      totalRuns: 524,
      firstTokenMedianMs: 1420,
      firstTokenSamples: 45,
      apiP95Ms: 290,
      apiRequests: 8400,
      totalCostUsd: 128.4,
      cacheHitPct: 74.2,
    },
    modules: [
      {
        key: 'brainstorm',
        label: 'Brainstorm',
        category: 'conversation',
        turns: 59,
        p50Sec: 28.9,
        avgSec: 40.6,
        p90Sec: 93.4,
        earliestP50Sec: 28.9,
        latestP50Sec: 28.9,
        deltaPct: null,
        successRatePct: null,
        avgCostUsd: null,
      },
      {
        key: 'design-doc-generation',
        label: 'Design Doc Generation',
        category: 'generation',
        turns: 105,
        p50Sec: 148.4,
        avgSec: 251.9,
        p90Sec: 618.1,
        earliestP50Sec: 635,
        latestP50Sec: 148.4,
        deltaPct: -76.6,
        successRatePct: 80.8,
        avgCostUsd: 0.72,
      },
    ],
    conversationTrend: [
      {
        bucket: '2026-10',
        label: 'Oct 26',
        homeChatP50Sec: 51.5,
        homeChatP90Sec: 224.3,
        interviewP50Sec: 21.5,
        interviewP90Sec: 51.5,
        brainstormP50Sec: null,
        brainstormP90Sec: null,
        adrP50Sec: null,
        adrP90Sec: null,
        totalTurns: 645,
      },
      {
        bucket: '2026-11',
        label: 'Nov 26',
        homeChatP50Sec: 21.8,
        homeChatP90Sec: 81.1,
        interviewP50Sec: 18.7,
        interviewP90Sec: 43.1,
        brainstormP50Sec: 28.9,
        brainstormP90Sec: 93.4,
        adrP50Sec: null,
        adrP90Sec: null,
        totalTurns: 281,
      },
    ],
    generationTrend: [
      {
        bucket: '2026-09',
        label: 'Sep 26',
        prdP50Min: 9.6,
        prdP90Min: 11.3,
        designDocP50Min: 10.6,
        designDocP90Min: 20.8,
        prototypeP50Min: null,
        testCaseP50Min: null,
        totalRuns: 44,
      },
      {
        bucket: '2026-11',
        label: 'Nov 26',
        prdP50Min: 3.5,
        prdP90Min: 5.0,
        designDocP50Min: 2.5,
        designDocP90Min: 10.3,
        prototypeP50Min: null,
        testCaseP50Min: null,
        totalRuns: 15,
      },
    ],
    homeChatSplit: [
      { bucket: '2026-11', label: 'Nov 26', appKnowledgeP50Sec: 36.7, otherSkillP50Sec: 12.1, freeChatP50Sec: 19.8, turns: 159 },
    ],
    stageTimings: {
      sampleCount: 45,
      ttftP50Ms: 1420,
      ttftP90Ms: 3100,
      firstEventP50Ms: 620,
      workspaceP50Ms: 180,
      acquireP50Ms: 250,
      workerTurnP50Ms: 19000,
      warmCount: 33,
      resumedCount: 9,
      recreatedCount: 3,
      byArea: [
        { area: 'brainstorm', label: 'Brainstorm', samples: 20, ttftP50Ms: 1200, ttftP90Ms: 2400, firstEventP50Ms: 480, workerTurnP50Ms: 17000, warmPct: 80 },
      ],
      trend: [
        { bucket: '2026-11', label: 'Nov 26', ttftP50Ms: 1420, firstEventP50Ms: 620, workerTurnP50Ms: 19000, samples: 45 },
      ],
    },
    reliability: {
      totalRuns: 524,
      completedRuns: 502,
      failedRuns: 18,
      cancelledRuns: 4,
      successRatePct: 95.8,
      queueWaitP50Sec: 0.7,
      queueWaitP90Sec: 3.4,
      terminalReasons: [{ reason: 'progress_timeout', count: 8 }],
      trend: [
        { bucket: '2026-11', label: 'Nov 26', successRatePct: 97.5, totalRuns: 120, failedRuns: 2, cancelledRuns: 1, queueWaitP50Sec: 0.5 },
      ],
    },
    apiExperience: {
      totalRequests: 8400,
      p50Ms: 44,
      p95Ms: 290,
      errorRatePct: 0.25,
      clientErrors: 5,
      trend: [
        { bucket: '2026-11', label: 'Nov 26', p50Ms: 41, p95Ms: 260, errorRatePct: 0.2, requests: 2100 },
      ],
      slowestRoutes: [
        { routeTemplate: '/api/prds/:id', requests: 300, p50Ms: 110, p95Ms: 620, errorRatePct: 0.3 },
      ],
    },
    costAndQuality: {
      totalCostUsd: 128.4,
      totalInteractions: 524,
      cacheHitPct: 74.2,
      trend: [
        { bucket: '2026-11', label: 'Nov 26', totalCostUsd: 38.5, avgCostPerRunUsd: 0.24, cacheHitPct: 78.1, interactions: 160 },
      ],
      byModel: [
        { modelId: 'claude-sonnet-4-6', runs: 310, avgSec: 31.2, p50Sec: 21.0, avgCostUsd: 0.22, totalCostUsd: 68.2, cacheHitPct: 76.5 },
      ],
      ratings: { good: 19, needsImprovement: 2, bad: 1, total: 22, positiveRatePct: 86.4 },
      flaggedThreads: { flagged: 2, total: 200, ratePct: 1.0 },
    },
    ...overrides,
  };
}

describe('AiExperienceDashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseObservabilityAiExperience.mockReturnValue({
      data: samplePayload(),
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  it('renders KPI strip, speed charts, module scoreboard, TTFT section, API & cost sections', () => {
    render(<AiExperienceDashboard flagProject="Apex" />);

    expect(screen.getByTestId('ai-experience-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('ai-experience-kpi-strip')).toHaveTextContent('24.5s');
    expect(screen.getByTestId('ai-experience-kpi-strip')).toHaveTextContent('1.42s');
    expect(screen.getByTestId('ai-experience-kpi-strip')).toHaveTextContent('95.8%');
    expect(screen.getByTestId('ai-experience-module-table')).toHaveTextContent('Design Doc Generation');
    expect(screen.getByTestId('ai-experience-module-table')).toHaveTextContent('77% faster');
    expect(screen.getByTestId('ai-experience-ttft-section')).toHaveTextContent('Warm 73%');
    expect(screen.getByTestId('ai-experience-api-section')).toHaveTextContent('/api/prds/:id');
    expect(screen.getByTestId('ai-experience-cost-section')).toHaveTextContent('claude-sonnet-4-6');
  });

  it('allows switching time window, granularity, project scope, and percentile', async () => {
    const user = userEvent.setup();
    render(<AiExperienceDashboard flagProject="Apex" />);

    await user.click(screen.getByTestId('ai-experience-window-30d'));
    expect(mockUseObservabilityAiExperience).toHaveBeenLastCalledWith('Apex', 'all', '30d', 'week');

    await user.selectOptions(screen.getByTestId('ai-experience-project-select'), 'MaxView');
    expect(mockUseObservabilityAiExperience).toHaveBeenLastCalledWith('Apex', 'MaxView', '30d', 'week');

    await user.click(screen.getByTestId('ai-experience-percentile-p90'));
    expect(screen.getByTestId('ai-experience-conversation-chart')).toHaveTextContent('p90');
  });

  it('shows active capture notice when no stage timing samples exist yet', () => {
    mockUseObservabilityAiExperience.mockReturnValue({
      data: samplePayload({
        stageTimings: {
          sampleCount: 0,
          ttftP50Ms: null,
          ttftP90Ms: null,
          firstEventP50Ms: null,
          workspaceP50Ms: null,
          acquireP50Ms: null,
          workerTurnP50Ms: null,
          warmCount: 0,
          resumedCount: 0,
          recreatedCount: 0,
          byArea: [],
          trend: [],
        },
      }),
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    });

    render(<AiExperienceDashboard flagProject="Apex" />);
    expect(screen.getByTestId('ai-experience-ttft-section')).toHaveTextContent(
      'Durable first-token & stage timing persistence is active',
    );
  });
});
