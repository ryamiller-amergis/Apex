import type { ProjectSkillConfig } from '../../../shared/types/projectSettings';

export interface AdoRepoCoords {
  adoProject: string;
  repo: string;
  branch: string;
}

export interface PipelineDefinitionSummary {
  enabled: boolean;
  repositoryName: string | null;
  repositoryId: string | null;
  /** Overridable variables (classic pipelines). */
  parameterNames: string[];
  /** YAML pipeline file; the check reads it separately so each read has its own timeout. */
  yamlPath: string | null;
}

/** A read that failed for a reason other than "not found". */
export class RepoReadUnavailableError extends Error {
  constructor(readonly cause?: unknown) {
    super('Repository read unavailable');
    this.name = 'RepoReadUnavailableError';
  }
}

/**
 * Everything preflight reads. File reads return null for a 404 and throw
 * RepoReadUnavailableError for anything else.
 */
export interface PreflightPorts {
  loadSettings(project: string, repository: string): Promise<ProjectSkillConfig | null>;
  isPairAllowed(project: string, repository: string): Promise<boolean>;
  isFlagEnabled(flag: string, ctx: { userId: string; project: string }): Promise<boolean>;
  /** userId → display name for users assigned to the project. */
  listAssignedUsers(project: string): Promise<Map<string, string>>;
  readFile(coords: AdoRepoCoords, path: string): Promise<string | null>;
  listFolder(coords: AdoRepoCoords, path: string): Promise<string[] | null>;
  readPipeline(coords: AdoRepoCoords, definitionId: number): Promise<PipelineDefinitionSummary | null>;
  redact(text: string): string;
  now(): Date;
  log(message: string): void;
}
