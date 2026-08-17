import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  LinkMutationResult,
  LinkedContextReadModel,
} from '../../../shared/types/interviewLinks';
import {
  interviewLinkKeys,
  useAddAdrLink,
  useLinkCandidates,
  useLinkedContext,
  useRemoveAdrLink,
} from '../useLinkedContext';

const INTERVIEW_ID = 'interview-1';
const PROJECT = 'Apex / Core';

const initialContext: LinkedContextReadModel = {
  interviewId: INTERVIEW_ID,
  adrLinks: [
    {
      adrId: 'adr-1',
      title: 'Accepted ADR',
      isAccepted: true,
      linkedBy: 'user-1',
      linkedAt: '2026-08-06T00:00:00.000Z',
    },
  ],
  designModuleLinks: [],
  count: 1,
  capacity: 10,
};

const authoritativeContext: LinkedContextReadModel = {
  ...initialContext,
  adrLinks: [
    ...initialContext.adrLinks,
    {
      adrId: 'adr-2',
      title: 'Authoritative ADR title',
      isAccepted: true,
      linkedBy: 'server-user',
      linkedAt: '2026-08-06T00:01:00.000Z',
    },
  ],
  count: 2,
};

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

function response(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(data),
  } as unknown as Response;
}

describe('useLinkedContext — TBI-003 DoD-2', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('DoD-2: uses stable keys and live persisted/kickoff candidate routes capped at 50', async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url === `/api/interviews/${INTERVIEW_ID}/links`) {
        return Promise.resolve(response(initialContext));
      }
      return Promise.resolve(response({ items: [], total: 0, offset: 0, limit: 50 }));
    });
    global.fetch = fetchMock;
    const { wrapper } = createWrapper();

    const { result: links } = renderHook(() => useLinkedContext(INTERVIEW_ID), { wrapper });
    const { result: persistedCandidates } = renderHook(
      () =>
        useLinkCandidates(PROJECT, INTERVIEW_ID, {
          type: 'adr',
          search: 'async',
          offset: 0,
          limit: 75,
        }),
      { wrapper },
    );
    const { result: kickoffCandidates } = renderHook(
      () =>
        useLinkCandidates(PROJECT, null, {
          type: 'design-module',
          offset: 0,
          limit: 50,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(links.current.isSuccess).toBe(true);
      expect(persistedCandidates.current.isSuccess).toBe(true);
      expect(kickoffCandidates.current.isSuccess).toBe(true);
    });

    expect(interviewLinkKeys.links(INTERVIEW_ID)).toEqual([
      'interview-links',
      INTERVIEW_ID,
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/interviews/${INTERVIEW_ID}/links`,
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/api\/interviews\/interview-1\/link-candidates\?.*type=adr.*limit=50/,
      ),
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/api\/interviews\/link-candidates\?.*project=Apex\+%2F\+Core.*type=design-module/,
      ),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('DoD-2 / VT-01: writes authoritative mutation data and invalidates links plus candidates', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      response({ linkedContext: authoritativeContext } satisfies LinkMutationResult),
    );
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(interviewLinkKeys.links(INTERVIEW_ID), initialContext);
    const invalidate = jest
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined);

    const { result } = renderHook(
      () => useAddAdrLink(INTERVIEW_ID, PROJECT),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({ adrId: 'adr-2' });
    });

    expect(queryClient.getQueryData(interviewLinkKeys.links(INTERVIEW_ID))).toEqual(
      authoritativeContext,
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: interviewLinkKeys.links(INTERVIEW_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: interviewLinkKeys.candidateRoot(PROJECT, INTERVIEW_ID),
    });
  });

  it('DoD-2 / VT-02 / BR-002: optimistically removes, restores on rejection, exposes body.error, and invalidates', async () => {
    let resolveFetch!: (value: Response) => void;
    global.fetch = jest.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { queryClient, wrapper } = createWrapper();
    queryClient.setQueryData(interviewLinkKeys.links(INTERVIEW_ID), initialContext);
    const invalidate = jest
      .spyOn(queryClient, 'invalidateQueries')
      .mockResolvedValue(undefined);

    const { result } = renderHook(
      () => useRemoveAdrLink(INTERVIEW_ID, PROJECT),
      { wrapper },
    );

    let mutationPromise!: Promise<unknown>;
    act(() => {
      mutationPromise = result.current.mutateAsync('adr-1').catch(() => undefined);
    });

    await waitFor(() => {
      expect(
        queryClient.getQueryData<LinkedContextReadModel>(
          interviewLinkKeys.links(INTERVIEW_ID),
        )?.adrLinks,
      ).toEqual([]);
    });

    resolveFetch(response({ error: 'Capacity changed on the server' }, false, 409));
    await act(async () => {
      await mutationPromise;
    });

    await waitFor(() => {
      expect(result.current.error?.message).toBe('Capacity changed on the server');
    });
    expect(queryClient.getQueryData(interviewLinkKeys.links(INTERVIEW_ID))).toEqual(
      initialContext,
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: interviewLinkKeys.links(INTERVIEW_ID),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: interviewLinkKeys.candidateRoot(PROJECT, INTERVIEW_ID),
    });
  });
});
