export type RunType = 'chat' | 'one_shot' | 'service';
export type RepoRole = 'target' | 'skill';
export type RepoProvider = 'github' | 'azure_devops';
export type GroundingSurface = 'interview' | 'prd' | 'design_doc' | 'chat' | 'adr';
export type PipelinePinPolicy = 'inherit' | 'latest';
export type DriftState = 'grounded' | 'source-changed' | 'unavailable';
export type GroundingStalenessState =
  | 'fresh'
  | 'soft-stale'
  | 'hard-checkpoint';

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

export type PreWarmTarget = ActiveRepositoryBranchQuery;

/**
 * Credential-free grounding metadata exposed to authorized run surfaces.
 * Domain surfaces resolve to the underlying persistence RunRef before use.
 */
export interface RunGroundingStatus {
  runType: RunType;
  runId: string;
  role: RepoRole;
  groundedSha: string;
  groundedShaShort: string;
  groundedAt: string;
  driftState: DriftState;
  stalenessState: GroundingStalenessState;
  commitsBehind: number;
  changedFileCount: number;
  canReGround: boolean;
}

export function isGroundingBehind(
  status: Pick<
    RunGroundingStatus,
    'driftState' | 'stalenessState' | 'commitsBehind'
  >,
): boolean {
  return (
    status.driftState === 'source-changed' ||
    status.stalenessState !== 'fresh' ||
    status.commitsBehind > 0
  );
}

export interface ReGroundRequest {
  role?: RepoRole;
}

export interface ReGroundResponse {
  previousSha: string;
  newSha: string;
  groundedAt: string;
}
