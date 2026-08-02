export type RunType = 'chat' | 'one_shot' | 'service';
export type RepoRole = 'target' | 'skill';
export type RepoProvider = 'github' | 'azure_devops';

export interface RunRef {
  runType: RunType;
  runId: string;
  /** Canonical Apex project used for authorization scope. */
  project: string;
}

export interface RunGrounding extends RunRef {
  id: string;
  repoRole: RepoRole;
  provider: RepoProvider;
  repository: string;
  branch: string;
  groundedSha: string;
  groundedAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunGroundingInput extends RunRef {
  repoRole: RepoRole;
  provider: RepoProvider;
  repository: string;
  branch: string;
  groundedSha: string;
  groundedAt?: string;
}

export interface ActiveRepositoryBranchQuery {
  provider: RepoProvider;
  /** Canonical Apex project scope, not provider organization credentials. */
  project: string;
  repository: string;
  branch: string;
}
