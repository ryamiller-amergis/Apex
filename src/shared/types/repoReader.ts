import type { SkillProvider } from './projectSettings';

declare const groundingProfileIdBrand: unique symbol;

/** Opaque process-local key. The value carries no repository or checkout data. */
export type GroundingProfileId = string & {
  readonly [groundingProfileIdBrand]: true;
};

export interface GroundingProfile {
  id: GroundingProfileId;
  expiresAt: number;
}

export interface RepositoryIdentity {
  provider: SkillProvider;
  project: string;
  repo: string;
  sha: string;
}

export interface RepoDirEntry {
  path: string;
  name: string;
  isFolder: boolean;
}

export interface RepoCodeSearchMatch {
  lineNumber?: number;
  snippet: string;
}

/** ADO-compatible shape also used for deterministic local search results. */
export interface RepoCodeSearchResult {
  path: string;
  fileName: string;
  repository: string;
  project: string;
  branch?: string;
  matches: RepoCodeSearchMatch[];
}

/** Existing GitHub remote-search shape, retained for fallback compatibility. */
export interface GitHubRepoCodeSearchResult {
  path: string;
  url: string;
  matches: Array<{ fragment: string }>;
}

export type RepoSearchResult = RepoCodeSearchResult | GitHubRepoCodeSearchResult;

export interface RepoReader {
  readonly identity: RepositoryIdentity;
  readFile(filePath: string): Promise<string>;
  listDir(dirPath: string): Promise<RepoDirEntry[]>;
  searchCode(query: string, limit?: number): Promise<RepoSearchResult[]>;
}
