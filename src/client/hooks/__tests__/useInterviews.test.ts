import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useInterviewList,
  useInterview,
  usePrdList,
  usePrd,
  usePrdTestCases,
  useCreateInterview,
  useUpdateInterviewStatus,
  useUpdateInterviewTitle,
  useDeleteInterview,
  useDeletePrd,
  useCreatePrd,
  useUpdatePrdContent,
  useSubmitPrd,
  useWithdrawPrd,
  useReviewPrd,
  useSyncPrd,
  useDesignDocList,
  useDesignDoc,
  useCreateDesignDoc,
  useUpdateDesignDocContent,
  useSubmitDesignDoc,
  useWithdrawDesignDoc,
  useReviewDesignDoc,
  useDeleteDesignDoc,
  useSyncDesignDoc,
  useReopenPrd,
  useActiveUsers,
  usePrdValidationReport,
  useCreatePrdValidationThread,
  useCancelPrdValidation,
  useRefreshPrdValidation,
  useMarkPrdValidationReady,
  useFixPrdValidation,
  useAcceptFixPrdValidation,
  useRevertPrdSection,
  useGenerateTestCases,
} from '../useInterviews';

// ── QueryClient wrapper ────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function mockFetchOk(data: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

function mockFetchNoContent() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 204,
    json: () => Promise.resolve(undefined),
  }) as jest.Mock;
}

function mockFetchError(status: number, body: unknown = { error: `HTTP ${status}` }) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const interviewSummary = {
  id: 'interview-1',
  chatThreadId: 'thread-1',
  authorId: 'user-1',
  title: 'Sprint Review',
  project: 'proj-alpha',
  repo: 'org/repo',
  status: 'in_progress',
  prdCount: 2,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const interview = { ...interviewSummary, prds: [] };

const prdSummary = {
  id: 'prd-1',
  interviewId: 'interview-1',
  chatThreadId: 'thread-2',
  authorId: 'user-1',
  title: 'Feature PRD',
  status: 'draft',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

const prd = { ...prdSummary, content: 'PRD content', backlogJson: null };

// ── useInterviewList ───────────────────────────────────────────────────────────

describe('useInterviewList', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/interviews and returns interview summaries', async () => {
    mockFetchOk([interviewSummary]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useInterviewList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ id: 'interview-1', title: 'Sprint Review' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/interviews'),
      expect.any(Object),
    );
  });

  it('includes status query param when filter is provided', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => useInterviewList({ status: 'complete' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('status=complete'),
      expect.any(Object),
    );
  });

  it('includes author=me query param when filter is provided', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => useInterviewList({ author: 'me' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('author=me'),
      expect.any(Object),
    );
  });

  it('surfaces fetch errors', async () => {
    mockFetchError(500, { error: 'Server error' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useInterviewList(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useInterview ───────────────────────────────────────────────────────────────

describe('useInterview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/interviews/:id and returns the interview', async () => {
    mockFetchOk(interview);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useInterview('interview-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ id: 'interview-1' });
  });

  it('does not fetch when id is null', async () => {
    mockFetchOk(interview);
    const { wrapper } = createWrapper();

    renderHook(() => useInterview(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── usePrdList ─────────────────────────────────────────────────────────────────

describe('usePrdList', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/interviews/prds and returns PRD summaries', async () => {
    mockFetchOk([prdSummary]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePrdList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ id: 'prd-1' });
  });

  it('includes status filter in the URL', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => usePrdList({ status: 'approved' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('status=approved'),
      expect.any(Object),
    );
  });

  it('includes author=me query param when filter is provided', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => usePrdList({ author: 'me' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('author=me'),
      expect.any(Object),
    );
  });
});

// ── usePrd ─────────────────────────────────────────────────────────────────────

describe('usePrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/interviews/prds/:id and returns the PRD', async () => {
    mockFetchOk(prd);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePrd('prd-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ id: 'prd-1', content: 'PRD content' });
  });

  it('does not fetch when id is null', async () => {
    mockFetchOk(prd);
    const { wrapper } = createWrapper();

    renderHook(() => usePrd(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── usePrdTestCases ───────────────────────────────────────────────────────────

describe('usePrdTestCases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/interviews/prds/:prdId/test-cases and returns the latest record', async () => {
    const testCaseRecord = {
      id: 'tc-1',
      prdId: 'prd-1',
      chatThreadId: 'thread-tc',
      status: 'ready',
      testCasesJson: { suites: [] },
      testCasesMd: '# Test Cases',
      coverageSummary: {
        totalCases: 3,
        pbisCovered: 1,
        acCovered: '2/2',
        brCovered: '1/1',
        gaps: 0,
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    };
    mockFetchOk(testCaseRecord);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => usePrdTestCases('prd-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({
      id: 'tc-1',
      coverageSummary: expect.objectContaining({ totalCases: 3 }),
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/test-cases',
      expect.any(Object),
    );
  });

  it('does not fetch test cases when prdId is null', async () => {
    mockFetchOk(null);
    const { wrapper } = createWrapper();

    renderHook(() => usePrdTestCases(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── useActiveUsers ─────────────────────────────────────────────────────────────

describe('useActiveUsers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/interviews/active-users and returns the list', async () => {
    const users = [
      { oid: 'alice', displayName: 'Alice Smith', email: 'alice@example.com' },
      { oid: 'bob', displayName: 'Bob Jones', email: 'bob@example.com' },
    ];
    mockFetchOk(users);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useActiveUsers(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0]).toMatchObject({ oid: 'alice', displayName: 'Alice Smith' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/active-users',
      expect.any(Object),
    );
  });

  it('returns an empty list when no active users exist', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useActiveUsers(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });
});

// ── useCreateInterview ─────────────────────────────────────────────────────────

describe('useCreateInterview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews and returns the created identifiers', async () => {
    mockFetchOk({ interviewId: 'interview-new', threadId: 'thread-new' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateInterview(), { wrapper });

    await act(async () => {
      result.current.mutate({ project: 'proj', repo: 'org/repo', chatThreadId: 'thread-x' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ interviewId: 'interview-new' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('includes prdOwnerId and designDocOwnerId in the POST body when provided', async () => {
    mockFetchOk({ interviewId: 'interview-new', threadId: 'thread-new' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateInterview(), { wrapper });

    await act(async () => {
      result.current.mutate({
        project: 'proj',
        repo: 'org/repo',
        chatThreadId: 'thread-x',
        prdOwnerId: 'user-prd',
        designDocOwnerId: 'user-dd',
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toMatchObject({ prdOwnerId: 'user-prd', designDocOwnerId: 'user-dd' });
  });

  it('surfaces errors from the API', async () => {
    mockFetchError(400, { error: 'project is required' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateInterview(), { wrapper });

    await act(async () => {
      result.current.mutate({ project: '', repo: 'org/repo', chatThreadId: 'thread-x' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

// ── useUpdateInterviewStatus ───────────────────────────────────────────────────

describe('useUpdateInterviewStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PATCHes /api/interviews/:id with the new status', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateInterviewStatus(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'interview-1', status: 'complete' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/interview-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});

// ── useUpdateInterviewTitle ────────────────────────────────────────────────────

describe('useUpdateInterviewTitle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PATCHes /api/interviews/:id with the new title', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateInterviewTitle(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'interview-1', title: 'New Title' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toMatchObject({ title: 'New Title' });
  });
});

// ── useDeleteInterview ─────────────────────────────────────────────────────────

describe('useDeleteInterview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs /api/interviews/:id', async () => {
    mockFetchNoContent();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteInterview(), { wrapper });

    await act(async () => {
      result.current.mutate('interview-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/interview-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// ── useDeletePrd ───────────────────────────────────────────────────────────────

describe('useDeletePrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs /api/interviews/prds/:prdId', async () => {
    mockFetchNoContent();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeletePrd(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// ── useCreatePrd ───────────────────────────────────────────────────────────────

describe('useCreatePrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/:interviewId/prds', async () => {
    mockFetchOk({ prdId: 'prd-new', threadId: 'thread-new' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreatePrd(), { wrapper });

    await act(async () => {
      result.current.mutate({ interviewId: 'interview-1', chatThreadId: 'thread-x', title: 'My PRD' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ prdId: 'prd-new' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/interview-1/prds',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── useUpdatePrdContent ────────────────────────────────────────────────────────

describe('useUpdatePrdContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PUTs new content to /api/interviews/prds/:prdId/content', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdatePrdContent(), { wrapper });

    await act(async () => {
      result.current.mutate({ prdId: 'prd-1', content: 'Updated content' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/content',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});

// ── useSubmitPrd ───────────────────────────────────────────────────────────────

describe('useSubmitPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/prds/:prdId/submit', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSubmitPrd(), { wrapper });

    await act(async () => {
      result.current.mutate({
        prdId: 'prd-1',
        prdApproverIds: ['approver-1'],
        designDocApproverIds: ['approver-2'],
        designPrototypeApproverIds: ['approver-3'],
        qaApproverIds: ['approver-4'],
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/submit',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── useWithdrawPrd ─────────────────────────────────────────────────────────────

describe('useWithdrawPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/prds/:prdId/withdraw', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useWithdrawPrd(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/withdraw',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── useReviewPrd ───────────────────────────────────────────────────────────────

describe('useReviewPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs an approve action to /api/interviews/prds/:prdId/review', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReviewPrd(), { wrapper });

    await act(async () => {
      result.current.mutate({ prdId: 'prd-1', action: 'approve' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/review',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toMatchObject({ action: 'approve' });
  });

});

// ── useSyncPrd ─────────────────────────────────────────────────────────────────

describe('useSyncPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/prds/:prdId/sync and returns content', async () => {
    mockFetchOk({ ok: true, content: '# Generated PRD' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSyncPrd(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ ok: true, content: '# Generated PRD' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/sync',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── useReopenPrd ──────────────────────────────────────────────────────────────

describe('useReopenPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/prds/:prdId/reopen', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReopenPrd(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/reopen',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── PRD validation hooks ──────────────────────────────────────────────────────

describe('PRD validation hooks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches the PRD validation report while validation is running', async () => {
    mockFetchOk({ markdown: '# Validation Report' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => usePrdValidationReport('prd-1', 'validation-thread-1', 'validating'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ markdown: '# Validation Report' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/validation/report',
      expect.any(Object),
    );
  });

  it('does not fetch the PRD validation report outside validating status', async () => {
    mockFetchOk({ markdown: '# Validation Report' });
    const { wrapper } = createWrapper();

    renderHook(
      () => usePrdValidationReport('prd-1', 'validation-thread-1', 'draft'),
      { wrapper },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs to create a PRD validation thread', async () => {
    mockFetchOk({ threadId: 'validation-thread-1' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreatePrdValidationThread(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/validation-thread',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POSTs to cancel PRD validation', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCancelPrdValidation(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/validation/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POSTs to refresh PRD validation results', async () => {
    mockFetchOk({ ok: true, score: 92, is_ready: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRefreshPrdValidation(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ score: 92, is_ready: true });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/validation/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POSTs to mark PRD validation ready', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useMarkPrdValidationReady(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/validation/mark-ready',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('POSTs to start and accept PRD validation fixes', async () => {
    mockFetchOk({ threadId: 'fix-thread-1' });
    const { wrapper } = createWrapper();

    const { result: fixResult } = renderHook(() => useFixPrdValidation(), { wrapper });

    await act(async () => {
      fixResult.current.mutate('prd-1');
    });

    await waitFor(() => expect(fixResult.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/fix-validation',
      expect.objectContaining({ method: 'POST' }),
    );

    mockFetchOk({ ok: true });
    const { result: acceptResult } = renderHook(() => useAcceptFixPrdValidation(), { wrapper });

    await act(async () => {
      acceptResult.current.mutate('prd-1');
    });

    await waitFor(() => expect(acceptResult.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenLastCalledWith(
      '/api/interviews/prds/prd-1/fix-validation/accept',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('PATCHes to revert the PRD validation baseline', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useRevertPrdSection(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/revert-section',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});

// ── Design Doc fixtures ────────────────────────────────────────────────────────

const designDocSummary = {
  id: 'dd-1',
  prdId: 'prd-1',
  project: 'proj-alpha',
  chatThreadId: 'thread-3',
  authorId: 'user-1',
  title: 'Feature Design Doc',
  status: 'draft',
  designContent: 'Design content',
  techSpecContent: 'Tech spec content',
  assumptionsContent: 'Assumptions content',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

// ── useDesignDocList ──────────────────────────────────────────────────────────

describe('useDesignDocList', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/interviews/design-docs and returns design doc summaries', async () => {
    mockFetchOk([designDocSummary]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDesignDocList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]).toMatchObject({ id: 'dd-1', title: 'Feature Design Doc' });
  });

  it('includes status filter in the URL', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => useDesignDocList({ status: 'approved' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('status=approved'),
      expect.any(Object),
    );
  });

  it('includes project filter in the URL', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => useDesignDocList({ project: 'proj-alpha' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('project=proj-alpha'),
      expect.any(Object),
    );
  });

  it('includes author=me query param when filter is provided', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();

    renderHook(() => useDesignDocList({ author: 'me' }), { wrapper });

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('author=me'),
      expect.any(Object),
    );
  });
});

// ── useDesignDoc ──────────────────────────────────────────────────────────────

describe('useDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches /api/interviews/design-docs/:id and returns the design doc', async () => {
    mockFetchOk(designDocSummary);
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDesignDoc('dd-1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ id: 'dd-1' });
  });

  it('does not fetch when id is null', async () => {
    mockFetchOk(designDocSummary);
    const { wrapper } = createWrapper();

    renderHook(() => useDesignDoc(null), { wrapper });

    await new Promise((r) => setTimeout(r, 50));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── useCreateDesignDoc ────────────────────────────────────────────────────────

describe('useCreateDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/prds/:prdId/design-docs', async () => {
    mockFetchOk({ designDocId: 'dd-new', threadId: 'thread-new' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useCreateDesignDoc(), { wrapper });

    await act(async () => {
      result.current.mutate({ prdId: 'prd-1' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ designDocId: 'dd-new' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/design-docs',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── useUpdateDesignDocContent ─────────────────────────────────────────────────

describe('useUpdateDesignDocContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PUTs content to /api/interviews/design-docs/:id/content', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useUpdateDesignDocContent(), { wrapper });

    await act(async () => {
      result.current.mutate({ designDocId: 'dd-1', designContent: 'Updated design' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/design-docs/dd-1/content',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});

// ── useSubmitDesignDoc ────────────────────────────────────────────────────────

describe('useSubmitDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/design-docs/:id/submit', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSubmitDesignDoc(), { wrapper });

    await act(async () => {
      result.current.mutate({
        designDocId: 'dd-1',
        approverIds: ['approver-1'],
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/design-docs/dd-1/submit',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── useWithdrawDesignDoc ──────────────────────────────────────────────────────

describe('useWithdrawDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/design-docs/:id/withdraw', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useWithdrawDesignDoc(), { wrapper });

    await act(async () => {
      result.current.mutate('dd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/design-docs/dd-1/withdraw',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// ── useReviewDesignDoc ────────────────────────────────────────────────────────

describe('useReviewDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs an approve action to /api/interviews/design-docs/:id/review', async () => {
    mockFetchOk({ ok: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useReviewDesignDoc(), { wrapper });

    await act(async () => {
      result.current.mutate({ designDocId: 'dd-1', action: 'approve' });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/design-docs/dd-1/review',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(callBody).toMatchObject({ action: 'approve' });
  });

});

// ── useDeleteDesignDoc ────────────────────────────────────────────────────────

describe('useDeleteDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DELETEs /api/interviews/design-docs/:id', async () => {
    mockFetchNoContent();
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useDeleteDesignDoc(), { wrapper });

    await act(async () => {
      result.current.mutate('dd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/design-docs/dd-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// ── useSyncDesignDoc ──────────────────────────────────────────────────────────

describe('useSyncDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/design-docs/:id/sync and returns content', async () => {
    mockFetchOk({ ok: true, designContent: '# Design', techSpecContent: '# Tech', assumptionsContent: '# Assumptions' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useSyncDesignDoc(), { wrapper });

    await act(async () => {
      result.current.mutate('dd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ ok: true, designContent: '# Design' });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/design-docs/dd-1/sync',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

// useGenerateDesignDoc removed — Q&A phase removed

// ── useGenerateTestCases ──────────────────────────────────────────────────────

describe('useGenerateTestCases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('POSTs to /api/interviews/prds/:prdId/test-cases/generate', async () => {
    mockFetchOk({ started: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateTestCases(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/interviews/prds/prd-1/test-cases/generate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('exposes started:true in mutation data', async () => {
    mockFetchOk({ started: true });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateTestCases(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ started: true });
  });

  it('enters error state on HTTP failure', async () => {
    mockFetchError(422, { error: 'PRD content and backlog must exist' });
    const { wrapper } = createWrapper();

    const { result } = renderHook(() => useGenerateTestCases(), { wrapper });

    await act(async () => {
      result.current.mutate('prd-1');
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
