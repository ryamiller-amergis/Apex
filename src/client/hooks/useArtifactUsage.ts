import type { EntityUsageRollup } from '../../shared/types/aiCostAnalytics';

export async function fetchEntityUsage(endpoint: string): Promise<EntityUsageRollup> {
  const res = await fetch(endpoint, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
