import type { GenerateReleaseChangelogResponse } from '../../shared/types/releaseChangelog';

export interface GenerateReleaseChangelogInput {
  epicId: number;
  project: string;
  areaPath?: string;
  forceRefresh?: boolean;
}

const inflightChangelogs = new Map<string, Promise<GenerateReleaseChangelogResponse>>();

async function postReleaseChangelog(
  input: GenerateReleaseChangelogInput,
): Promise<GenerateReleaseChangelogResponse> {
  const response = await fetch(`/api/releases/${input.epicId}/changelog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: input.project,
      areaPath: input.areaPath,
      forceRefresh: input.forceRefresh,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || 'Failed to generate release changelog');
  }

  return (await response.json()) as GenerateReleaseChangelogResponse;
}

/**
 * One in-flight request per release. Dev Strict Mode mounts the modal twice;
 * the duplicate post does not come back, and that was the request the open
 * modal waited on.
 */
export function requestReleaseChangelog(
  input: GenerateReleaseChangelogInput,
): Promise<GenerateReleaseChangelogResponse> {
  const key = `${input.project}:${input.areaPath ?? ''}:${input.epicId}:${input.forceRefresh ? '1' : '0'}`;
  const existing = inflightChangelogs.get(key);
  if (existing) return existing;

  const work = postReleaseChangelog(input).finally(() => {
    if (inflightChangelogs.get(key) === work) {
      inflightChangelogs.delete(key);
    }
  });
  inflightChangelogs.set(key, work);
  return work;
}
