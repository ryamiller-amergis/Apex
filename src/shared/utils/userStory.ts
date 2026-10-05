/**
 * PBI user stories are stored as `{ persona, iWant, soThat }`.
 * Some `/to-prd` runs emit `want` instead of `iWant`, which drops the
 * "I want to" clause in the PRD/backlog UI.
 */

export interface PbiUserStory {
  persona?: string;
  iWant?: string;
  soThat?: string;
}

interface RawPbiUserStory extends PbiUserStory {
  want?: string;
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveUserStoryIWant(
  us: RawPbiUserStory | null | undefined,
): string {
  if (!us || typeof us !== 'object') return '';
  return trimString(us.iWant) || trimString(us.want);
}

export function normalizePbiUserStory(
  us: unknown,
): PbiUserStory | undefined {
  if (!us || typeof us !== 'object') return undefined;
  const raw = us as RawPbiUserStory;
  const persona = trimString(raw.persona);
  const iWant = resolveUserStoryIWant(raw);
  const soThat = trimString(raw.soThat);
  if (!persona && !iWant && !soThat) return undefined;
  return {
    ...(persona ? { persona } : {}),
    ...(iWant ? { iWant } : {}),
    ...(soThat ? { soThat } : {}),
  };
}

interface BacklogItemNode {
  type?: string;
  userStory?: unknown;
  [key: string]: unknown;
}

interface BacklogFeatureNode {
  items?: BacklogItemNode[];
  [key: string]: unknown;
}

interface BacklogEpicNode {
  features?: BacklogFeatureNode[];
  [key: string]: unknown;
}

interface BacklogJsonNode {
  epics?: BacklogEpicNode[];
  [key: string]: unknown;
}

export function normalizeBacklogUserStories<T>(backlog: T): T {
  if (backlog === null || backlog === undefined || typeof backlog !== 'object') {
    return backlog;
  }

  const clone = JSON.parse(JSON.stringify(backlog)) as BacklogJsonNode;
  for (const epic of clone.epics ?? []) {
    for (const feature of epic.features ?? []) {
      for (const item of feature.items ?? []) {
        if (item.type !== 'PBI') continue;
        const normalized = normalizePbiUserStory(item.userStory);
        if (normalized) item.userStory = normalized;
      }
    }
  }
  return clone as T;
}
