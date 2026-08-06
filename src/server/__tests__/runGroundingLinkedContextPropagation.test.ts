const mockInterviewFindFirst = jest.fn();
const mockPrdFindFirst = jest.fn();
const mockDesignDocFindFirst = jest.fn();
const mockChatThreadFindFirst = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: (...args: unknown[]) => mockInterviewFindFirst(...args) },
      prds: { findFirst: (...args: unknown[]) => mockPrdFindFirst(...args) },
      designDocs: { findFirst: (...args: unknown[]) => mockDesignDocFindFirst(...args) },
      chatThreads: { findFirst: (...args: unknown[]) => mockChatThreadFindFirst(...args) },
    },
  },
}));

jest.mock('../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

jest.mock('../services/interviewLinkService', () => ({
  getLinkedContext: jest.fn(),
}));

jest.mock('../services/adrService', () => ({
  getAdr: jest.fn(),
}));

jest.mock('../services/designModuleService', () => ({
  getModuleById: jest.fn(),
}));

import type { MaterializeResult } from '../services/linkedContextMaterializerService';
import {
  materializeLinkedContextForPipelineHandoff,
} from '../services/linkedContextMaterializerService';
import {
  propagatePipelineGrounding,
  type RunGroundingService,
} from '../services/runGroundingService';
import type { RunRef } from '../../shared/types/runGrounding';

const interviewRun: RunRef = {
  runType: 'chat',
  runId: 'interview-thread',
  project: 'Apex',
};
const prdRun: RunRef = {
  runType: 'chat',
  runId: 'prd-thread',
  project: 'Apex',
};
const designRun: RunRef = {
  runType: 'chat',
  runId: 'design-thread',
  project: 'Apex',
};

function materializeResult(
  outcome: MaterializeResult['outcome'],
): MaterializeResult {
  return {
    outcome,
    adrCount: outcome === 'written' ? 1 : 0,
    designModuleCount: 0,
    staleAdrExcluded: outcome === 'omitted' ? 1 : 0,
    durationMs: 5,
  };
}

function groundingServiceMock(): jest.Mocked<RunGroundingService> {
  return {
    activateGroundings: jest.fn(),
    copyGrounding: jest.fn(),
    copyGroundingByValue: jest.fn().mockResolvedValue({
      grounding: null,
      materialization: 'unavailable',
    }),
    getGroundings: jest.fn(),
    findActiveByRepoBranch: jest.fn(),
    reground: jest.fn(),
    deactivate: jest.fn(),
    markTerminalInactive: jest.fn(),
    persistThenMarkTerminalInactive: jest.fn(),
    getStatus: jest.fn(),
    reGroundFromCache: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TBI-006 S3 pipeline linked-context propagation', () => {
  it('DoD-0 / VT-06 Given an Interview→PRD handoff, When propagation runs, Then the live materializer receives the originating Interview and destination workspace within 2 seconds', async () => {
    // Given
    mockInterviewFindFirst.mockResolvedValue({
      id: 'interview-id',
      project: 'Apex',
    });
    mockPrdFindFirst.mockResolvedValue({
      id: 'prd-id',
      interviewId: 'interview-id',
      project: 'Apex',
    });
    mockChatThreadFindFirst.mockResolvedValue({
      workspaceDir: 'C:\\workspaces\\prd',
    });
    const materialize = jest.fn().mockResolvedValue(materializeResult('written'));
    const started = Date.now();

    // When
    const result = await materializeLinkedContextForPipelineHandoff(
      interviewRun,
      prdRun,
      'user-owner',
      { materialize },
    );

    // Then
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result?.outcome).toBe('written');
    expect(materialize).toHaveBeenCalledWith('interview-id', {
      workspaceDir: 'C:\\workspaces\\prd',
      actor: { userId: 'user-owner' },
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'grounding.linked-context.propagate',
      { surface: 'prd', outcome: 'materialized' },
      { durationMs: expect.any(Number) },
    );
  });

  it('DoD-1 Given a PRD→design handoff, When propagation runs, Then it resolves the originating Interview through the source PRD', async () => {
    // Given
    mockInterviewFindFirst.mockResolvedValue(null);
    mockPrdFindFirst.mockResolvedValue({
      id: 'prd-id',
      interviewId: 'interview-id',
      project: 'Apex',
    });
    mockDesignDocFindFirst.mockResolvedValue({
      id: 'design-id',
      prdId: 'prd-id',
      project: 'Apex',
    });
    mockChatThreadFindFirst.mockResolvedValue({
      workspaceDir: 'C:\\workspaces\\design',
    });
    const materialize = jest.fn().mockResolvedValue(materializeResult('written'));

    // When
    await materializeLinkedContextForPipelineHandoff(
      prdRun,
      designRun,
      'user-owner',
      { materialize },
    );

    // Then
    expect(materialize).toHaveBeenCalledWith('interview-id', {
      workspaceDir: 'C:\\workspaces\\design',
      actor: { userId: 'user-owner' },
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'grounding.linked-context.propagate',
      { surface: 'design', outcome: 'materialized' },
      { durationMs: expect.any(Number) },
    );
  });

  it('GA decision Given repository grounding is disabled, When the handoff runs, Then linked context propagates first and independently', async () => {
    // Given
    const order: string[] = [];
    const propagateLinkedContext = jest.fn(async () => {
      order.push('linked-context');
      return materializeResult('written');
    });
    const isFeatureEnabled = jest.fn(async () => {
      order.push('feature-flag');
      return false;
    });
    const service = groundingServiceMock();

    // When
    const result = await propagatePipelineGrounding(
      interviewRun,
      prdRun,
      'user-owner',
      { service, isFeatureEnabled, propagateLinkedContext },
    );

    // Then
    expect(result).toBeNull();
    expect(order).toEqual(['linked-context', 'feature-flag']);
    expect(propagateLinkedContext).toHaveBeenCalledWith(
      interviewRun,
      prdRun,
      'user-owner',
    );
    expect(service.copyGroundingByValue).not.toHaveBeenCalled();
  });

  it('VT-07 Given an unexpected linked-context helper failure, When repository grounding is enabled, Then propagation warns without the error body and continues', async () => {
    // Given
    const service = groundingServiceMock();
    const propagateLinkedContext = jest
      .fn()
      .mockRejectedValue(new Error('secret artifact body must not be logged'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      // When
      await expect(
        propagatePipelineGrounding(interviewRun, prdRun, 'user-owner', {
          service,
          isFeatureEnabled: jest.fn().mockResolvedValue(true),
          propagateLinkedContext,
        }),
      ).resolves.toEqual({
        grounding: null,
        materialization: 'unavailable',
      });

      // Then
      expect(service.copyGroundingByValue).toHaveBeenCalledWith(
        interviewRun,
        prdRun,
        'target',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret artifact body');
      expect(warn).toHaveBeenCalledWith(
        '[linked-context] pipeline propagation unavailable error=Error',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('TBI-006 S4 absent, stale, and unrelated guards', () => {
  it.each([
    {
      handoff: 'Interview→PRD',
      from: interviewRun,
      to: prdRun,
      surface: 'prd',
      workspaceDir: 'C:\\workspaces\\prd',
      arrange: () => {
        mockInterviewFindFirst.mockResolvedValue({
          id: 'interview-id',
          project: 'Apex',
        });
        mockPrdFindFirst.mockResolvedValue({
          id: 'prd-id',
          interviewId: 'interview-id',
          project: 'Apex',
        });
      },
    },
    {
      handoff: 'PRD→design',
      from: prdRun,
      to: designRun,
      surface: 'design',
      workspaceDir: 'C:\\workspaces\\design',
      arrange: () => {
        mockInterviewFindFirst.mockResolvedValue(null);
        mockPrdFindFirst.mockResolvedValue({
          id: 'prd-id',
          interviewId: 'interview-id',
          project: 'Apex',
        });
        mockDesignDocFindFirst.mockResolvedValue({
          id: 'design-id',
          prdId: 'prd-id',
          project: 'Apex',
        });
      },
    },
  ])('DoD-2 / AC-1 / VT-03 Given no effective links (including stale-only), When $handoff runs, Then omitted context remains nonblocking', async ({
    from,
    to,
    surface,
    workspaceDir,
    arrange,
  }) => {
    // Given
    arrange();
    mockChatThreadFindFirst.mockResolvedValue({ workspaceDir });
    const materialize = jest.fn().mockResolvedValue(materializeResult('omitted'));

    // When
    const result = await materializeLinkedContextForPipelineHandoff(
      from,
      to,
      'user-owner',
      { materialize },
    );

    // Then
    expect(result?.outcome).toBe('omitted');
    expect(result?.staleAdrExcluded).toBe(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'grounding.linked-context.propagate',
      { surface, outcome: 'empty' },
      { durationMs: expect.any(Number) },
    );
  });

  it('DoD-2 / AC-1 Given an applicable destination has no workspace, When handoff resolution runs, Then it returns null without materializing or blocking', async () => {
    // Given
    mockInterviewFindFirst.mockResolvedValue({
      id: 'interview-id',
      project: 'Apex',
    });
    mockPrdFindFirst.mockResolvedValue({
      id: 'prd-id',
      interviewId: 'interview-id',
      project: 'Apex',
    });
    mockChatThreadFindFirst.mockResolvedValue({ workspaceDir: null });
    const materialize = jest.fn();

    // When
    const result = await materializeLinkedContextForPipelineHandoff(
      interviewRun,
      prdRun,
      'user-owner',
      { materialize },
    );

    // Then
    expect(result).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
  });

  it.each([
    {
      criterion: 'VT-05 unrelated run',
      from: { ...interviewRun, runType: 'service' as const },
      to: prdRun,
      arrange: () => undefined,
    },
    {
      criterion: 'VT-05 cross-project destination',
      from: interviewRun,
      to: { ...prdRun, project: 'Other' },
      arrange: () => {
        mockInterviewFindFirst.mockResolvedValue({
          id: 'interview-id',
          project: 'Apex',
        });
        mockPrdFindFirst.mockResolvedValue({
          id: 'prd-id',
          interviewId: 'interview-id',
          project: 'Other',
        });
      },
    },
    {
      criterion: 'VT-05 unrelated PRD destination',
      from: interviewRun,
      to: prdRun,
      arrange: () => {
        mockInterviewFindFirst.mockResolvedValue({
          id: 'interview-id',
          project: 'Apex',
        });
        mockPrdFindFirst.mockResolvedValue({
          id: 'prd-id',
          interviewId: 'different-interview',
          project: 'Apex',
        });
      },
    },
  ])('$criterion Given an inapplicable handoff, When resolved, Then no linked context is supplied', async ({
    from,
    to,
    arrange,
  }) => {
    // Given
    arrange();
    const materialize = jest.fn();

    // When
    const result = await materializeLinkedContextForPipelineHandoff(
      from,
      to,
      'user-owner',
      { materialize },
    );

    // Then
    expect(result).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('AC-1 / VT-07 Given the live materializer is unavailable, When an applicable handoff runs, Then failure is diagnostic-only and no body reaches telemetry', async () => {
    // Given
    mockInterviewFindFirst.mockResolvedValue({
      id: 'interview-id',
      project: 'Apex',
    });
    mockPrdFindFirst.mockResolvedValue({
      id: 'prd-id',
      interviewId: 'interview-id',
      project: 'Apex',
    });
    mockChatThreadFindFirst.mockResolvedValue({
      workspaceDir: 'C:\\workspaces\\prd',
    });
    const materialize = jest
      .fn()
      .mockRejectedValue(new Error('sensitive linked content'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      // When
      await expect(
        materializeLinkedContextForPipelineHandoff(
          interviewRun,
          prdRun,
          'user-owner',
          { materialize },
        ),
      ).resolves.toBeNull();

      // Then
      expect(mockTrackEvent).toHaveBeenCalledWith(
        'grounding.linked-context.propagate',
        { surface: 'prd', outcome: 'unavailable' },
        { durationMs: expect.any(Number) },
      );
      expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain(
        'sensitive linked content',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'sensitive linked content',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
