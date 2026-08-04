/**
 * FEAT-008 — Platform Admin Walkthrough acknowledgement + anchor-miss reporting hooks.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  WalkthroughAcknowledgementReport,
  WalkthroughAcknowledgementStatusFilter,
  WalkthroughAnchorMissPage,
  WalkthroughCatalogPage,
} from '../../shared/types/walkthrough';

export const walkthroughReportingKeys = {
  catalog: ['platform-admin', 'walkthrough-reports', 'catalog'] as const,
  acknowledgement: (id: string | null, status: WalkthroughAcknowledgementStatusFilter) =>
    ['platform-admin', 'walkthrough-reports', 'acknowledgement', id, status] as const,
  anchorMisses: (id: string | null) =>
    ['platform-admin', 'walkthrough-reports', 'anchor-misses', id] as const,
};

async function reportingFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function usePublishedWalkthroughCatalog() {
  return useInfiniteQuery<WalkthroughCatalogPage>({
    queryKey: walkthroughReportingKeys.catalog,
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ lifecycle: 'published' });
      if (pageParam) search.set('cursor', pageParam as string);
      return reportingFetch<WalkthroughCatalogPage>(
        `/api/platform-admin/walkthroughs?${search.toString()}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
  });
}

export function useWalkthroughAcknowledgementReport(
  walkthroughId: string | null,
  status: WalkthroughAcknowledgementStatusFilter = 'all',
) {
  return useQuery<WalkthroughAcknowledgementReport>({
    queryKey: walkthroughReportingKeys.acknowledgement(walkthroughId, status),
    queryFn: () => {
      const search = new URLSearchParams({ status });
      return reportingFetch<WalkthroughAcknowledgementReport>(
        `/api/platform-admin/walkthroughs/${encodeURIComponent(walkthroughId!)}/reports/acknowledgement?${search}`,
      );
    },
    enabled: Boolean(walkthroughId),
    staleTime: 15_000,
  });
}

export function useWalkthroughAnchorMisses(walkthroughId: string | null) {
  return useInfiniteQuery<WalkthroughAnchorMissPage>({
    queryKey: walkthroughReportingKeys.anchorMisses(walkthroughId),
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: '50' });
      if (pageParam) search.set('cursor', pageParam as string);
      return reportingFetch<WalkthroughAnchorMissPage>(
        `/api/platform-admin/walkthroughs/${encodeURIComponent(walkthroughId!)}/reports/anchor-misses?${search}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(walkthroughId),
    staleTime: 15_000,
  });
}
