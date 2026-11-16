export const RELEASE_PLATFORM_COLORS = [
  'blue',
  'teal',
  'purple',
  'amber',
  'emerald',
  'rose',
  'slate',
] as const;

export type ReleasePlatformColor = (typeof RELEASE_PLATFORM_COLORS)[number];

export interface ReleasePlatform {
  id: string;
  project: string;
  slug: string;
  name: string;
  color: ReleasePlatformColor;
  sortOrder: number;
  createdBy?: string | null;
  createdAt: string;
}

export interface ReleasePlatformPreset {
  name: string;
  slug: string;
  color: ReleasePlatformColor;
}

export const RELEASE_PLATFORM_PRESETS: readonly ReleasePlatformPreset[] = [
  { name: 'Desktop', slug: 'desktop', color: 'blue' },
  { name: 'Mobile', slug: 'mobile', color: 'purple' },
  { name: 'Web', slug: 'web', color: 'teal' },
  { name: 'iOS', slug: 'ios', color: 'rose' },
  { name: 'Android', slug: 'android', color: 'emerald' },
  { name: 'API', slug: 'api', color: 'amber' },
  { name: 'Backend', slug: 'backend', color: 'slate' },
] as const;

export interface ReleasePlatformSummaryChildItem {
  id: number;
  state: string;
  workItemType?: string;
  tags?: string;
  /** Ancestor IDs from immediate parent up to the linked Feature/Epic (for platform inheritance). */
  ancestorIds?: number[];
  /** Combined semicolon-separated tags from ancestor Feature/Epic items (for tag-based platform inheritance). */
  ancestorTags?: string;
}

export interface ProjectReleasePlatformsState {
  project: string;
  platforms: ReleasePlatform[];
  /** Map of ADO Release Epic ID -> explicit platform IDs */
  epicPlatformIds: Record<number, string[]>;
  /** Map of ADO Work Item ID -> explicit platform IDs */
  workItemPlatformIds: Record<number, string[]>;
}

/**
 * Normalizes a platform name into a URL/testId-safe slug.
 */
export function slugifyReleasePlatform(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isValidReleasePlatformColor(value: unknown): value is ReleasePlatformColor {
  return (
    typeof value === 'string' &&
    (RELEASE_PLATFORM_COLORS as readonly string[]).includes(value)
  );
}

/**
 * Splits an ADO `System.Tags` string (semicolon-separated) into normalized lowercase tokens.
 */
export function parseAdoTags(tags?: string | null): string[] {
  if (!tags || typeof tags !== 'string') return [];
  return tags
    .split(';')
    .map((raw) => raw.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

/**
 * Returns configured platform IDs matched by ADO `System.Tags` (case-insensitive):
 * `<PlatformName>`, `<slug>`, `Platform:<PlatformName>`, or `Platform:<slug>`.
 */
export function matchPlatformsFromTags(
  tags: string | null | undefined,
  platforms: readonly ReleasePlatform[],
): string[] {
  if (!tags || platforms.length === 0) return [];
  const tokens = new Set(parseAdoTags(tags));
  if (tokens.size === 0) return [];

  const matchedIds: string[] = [];
  for (const platform of platforms) {
    const lowerName = platform.name.trim().toLowerCase();
    const lowerSlug = platform.slug.trim().toLowerCase();
    const candidates = [
      lowerName,
      lowerSlug,
      `platform:${lowerName}`,
      `platform:${lowerSlug}`,
      `platform: ${lowerName}`,
      `platform: ${lowerSlug}`,
    ];
    if (candidates.some((candidate) => tokens.has(candidate))) {
      matchedIds.push(platform.id);
    }
  }
  return matchedIds;
}

/**
 * Resolves effective platforms (ordered by `sortOrder`) for a single work item
 * by unioning explicit DB platform IDs and ADO tag matches against live project platforms.
 * If the item itself has no explicit or tag-matched platform, falls back to inherited
 * platforms from `ancestorIds` / `ancestorTags` (e.g. a PBI inheriting from its parent Feature).
 */
export function resolveWorkItemPlatforms(
  item: {
    id: number;
    tags?: string | null;
    ancestorIds?: readonly number[];
    ancestorTags?: string | null;
  },
  platforms: readonly ReleasePlatform[],
  workItemPlatformIds: Readonly<Record<number, readonly string[]>>,
): ReleasePlatform[] {
  if (platforms.length === 0) return [];

  const explicit = workItemPlatformIds[item.id] ?? [];
  const tagMatched = matchPlatformsFromTags(item.tags, platforms);
  const selectedSet = new Set<string>([...explicit, ...tagMatched]);

  if (selectedSet.size === 0) {
    if (item.ancestorIds && item.ancestorIds.length > 0) {
      for (const ancestorId of item.ancestorIds) {
        for (const id of workItemPlatformIds[ancestorId] ?? []) {
          selectedSet.add(id);
        }
        if (selectedSet.size > 0) break;
      }
    }
    if (selectedSet.size === 0 && item.ancestorTags) {
      for (const id of matchPlatformsFromTags(item.ancestorTags, platforms)) {
        selectedSet.add(id);
      }
    }
  }

  if (selectedSet.size === 0) return [];

  return [...platforms]
    .filter((platform) => selectedSet.has(platform.id))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Resolves effective platforms (ordered by `sortOrder`) for a release epic
 * by unioning:
 *  1. Explicit epic platform assignments in Apex DB
 *  2. ADO tag matches on the release epic itself (if present)
 *  3. Effective platforms of all linked work items and rolled-up leaf items
 */
export function resolveReleaseEpicPlatforms(
  epic: {
    id: number;
    tags?: string | null;
    childItemsSummary?: readonly ReleasePlatformSummaryChildItem[];
  },
  platforms: readonly ReleasePlatform[],
  epicPlatformIds: Readonly<Record<number, readonly string[]>>,
  workItemPlatformIds: Readonly<Record<number, readonly string[]>>,
  loadedChildren?: readonly {
    id: number;
    tags?: string | null;
    ancestorIds?: readonly number[];
    ancestorTags?: string | null;
  }[],
): ReleasePlatform[] {
  if (platforms.length === 0) return [];

  const selectedSet = new Set<string>(epicPlatformIds[epic.id] ?? []);
  for (const id of matchPlatformsFromTags(epic.tags, platforms)) {
    selectedSet.add(id);
  }

  for (const child of epic.childItemsSummary ?? []) {
    for (const p of resolveWorkItemPlatforms(child, platforms, workItemPlatformIds)) {
      selectedSet.add(p.id);
    }
  }

  if (loadedChildren) {
    for (const child of loadedChildren) {
      for (const p of resolveWorkItemPlatforms(child, platforms, workItemPlatformIds)) {
        selectedSet.add(p.id);
      }
    }
  }

  if (selectedSet.size === 0) return [];
  return [...platforms]
    .filter((platform) => selectedSet.has(platform.id))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}
