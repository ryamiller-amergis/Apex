export const RELEASE_CHANGELOG_SKILL_PATH = '.cursor/skills/release-changelog/SKILL.md';

export interface ReleaseChangelogItemNode {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  tags: string;
  descriptionExcerpt: string;
  /** Resolved platform names from explicit Apex assignments, ADO tags, or ancestor inheritance. */
  platforms: string[];
  /** Smart platform names inferred from title/description keywords when no explicit/tag platform was set. */
  inferredPlatforms?: string[];
  /** Child deliverables (e.g. PBIs, TBIs, Bugs, or sub-Features) when this item is an Epic or Feature. */
  children: ReleaseChangelogItemNode[];
}

export interface GenerateReleaseChangelogRequest {
  project: string;
  areaPath?: string;
  forceRefresh?: boolean;
}

export interface GenerateReleaseChangelogResponse {
  epicId: number;
  version: string;
  filename: string;
  markdown: string;
  itemCount: number;
  leafItemCount: number;
  platformsIncluded: string[];
  generatedAt: string;
  durationMs?: number;
  modelUsed?: string | null;
  skillPathUsed?: string;
  source: 'ai' | 'fallback';
}
