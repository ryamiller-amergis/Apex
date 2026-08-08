/**
 * S4 — useDiagramShares hooks (PBI-007)
 */
import { type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useChangeShareAccess,
  useCreateShare,
  useDiagramShares,
  useRevokeShare,
  useShareTargets,
} from '../useDiagramShares';
import * as api from '../../services/diagramApi';

jest.mock('../../services/diagramApi');

const mockedApi = api as jest.Mocked<typeof api>;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDiagramShares hooks (PBI-007)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads shares for a diagram', async () => {
    mockedApi.listDiagramShares.mockResolvedValue([
      {
        id: 'share-1',
        diagramId: 'd1',
        granteeId: 'u2',
        granteeName: 'Two',
        access: 'view',
        createdAt: '2026-08-06T00:00:00.000Z',
      },
    ]);

    const { result } = renderHook(() => useDiagramShares('p1', 'd1'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].granteeId).toBe('u2');
    expect(mockedApi.listDiagramShares).toHaveBeenCalledWith('p1', 'd1');
  });

  it('loads annotated share targets', async () => {
    mockedApi.listShareTargets.mockResolvedValue([
      {
        userId: 'u2',
        displayName: 'Two',
        email: null,
        existingAccess: null,
      },
    ]);

    const { result } = renderHook(() => useShareTargets('p1', 'd1', ''), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi.listShareTargets).toHaveBeenCalledWith('p1', 'd1', '');
  });

  it('create / change / revoke call API helpers', async () => {
    mockedApi.createDiagramShare.mockResolvedValue({
      id: 'share-1',
      diagramId: 'd1',
      granteeId: 'u2',
      granteeName: null,
      access: 'view',
      createdAt: '2026-08-06T00:00:00.000Z',
    });
    mockedApi.changeDiagramShareAccess.mockResolvedValue({
      id: 'share-1',
      diagramId: 'd1',
      granteeId: 'u2',
      granteeName: null,
      access: 'edit',
      createdAt: '2026-08-06T00:00:00.000Z',
    });
    mockedApi.revokeDiagramShare.mockResolvedValue();

    const create = renderHook(() => useCreateShare('p1', 'd1'), { wrapper });
    create.result.current.mutate({ granteeId: 'u2', access: 'view' });
    await waitFor(() => expect(create.result.current.isSuccess).toBe(true));

    const change = renderHook(() => useChangeShareAccess('p1', 'd1'), { wrapper });
    change.result.current.mutate({ granteeId: 'u2', access: 'edit' });
    await waitFor(() => expect(change.result.current.isSuccess).toBe(true));

    const revoke = renderHook(() => useRevokeShare('p1', 'd1'), { wrapper });
    revoke.result.current.mutate('u2');
    await waitFor(() => expect(revoke.result.current.isSuccess).toBe(true));

    expect(mockedApi.createDiagramShare).toHaveBeenCalled();
    expect(mockedApi.changeDiagramShareAccess).toHaveBeenCalled();
    expect(mockedApi.revokeDiagramShare).toHaveBeenCalledWith('p1', 'd1', 'u2');
  });
});
