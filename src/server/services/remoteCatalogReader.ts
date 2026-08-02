import type {
  RepoDirEntry,
  RepoReader,
  RepoSearchResult,
  RepositoryIdentity,
} from '../../shared/types/repoReader';
import * as skillCatalogFacade from './skillCatalogFacade';
import {
  isRemoteSearchConvergenceEnabled as evaluateConvergence,
  type GroundingFlagContext,
} from './featureFlagService';
import { boundedSearchLimit, RepoReaderError } from './repoReader';

export interface RemoteCatalog {
  getSkillFile(
    project: string,
    repo: string,
    filePath: string,
    branch: string | undefined,
    provider: RepositoryIdentity['provider']
  ): Promise<string>;
  listRepoDir(
    project: string,
    repo: string,
    dirPath: string,
    branch: string | undefined,
    provider: RepositoryIdentity['provider']
  ): Promise<RepoDirEntry[]>;
  searchRepoCode(
    project: string,
    repo: string,
    query: string,
    branch: string | undefined,
    limit: number,
    provider: RepositoryIdentity['provider']
  ): Promise<RepoSearchResult[]>;
}

export interface RemoteCatalogReaderOptions {
  flagContext?: GroundingFlagContext;
  isConvergenceEnabled?: typeof evaluateConvergence;
}

export class RemoteCatalogReader implements RepoReader {
  readonly identity: RepositoryIdentity;

  constructor(
    identity: RepositoryIdentity,
    private readonly catalog: RemoteCatalog = skillCatalogFacade,
    private readonly options: RemoteCatalogReaderOptions = {}
  ) {
    this.identity = { ...identity };
  }

  readFile(filePath: string): Promise<string> {
    return this.catalog.getSkillFile(
      this.identity.project,
      this.identity.repo,
      filePath,
      this.identity.sha,
      this.identity.provider
    );
  }

  listDir(dirPath: string): Promise<RepoDirEntry[]> {
    return this.catalog.listRepoDir(
      this.identity.project,
      this.identity.repo,
      dirPath,
      this.identity.sha,
      this.identity.provider
    );
  }

  async searchCode(query: string, limit?: number): Promise<RepoSearchResult[]> {
    const convergenceEnabled = this.options.flagContext
      ? await (this.options.isConvergenceEnabled ?? evaluateConvergence)(
          this.options.flagContext
        )
      : false;

    // @feature-flag:repo-grounding-remote-search-convergence start winner=enabled
    if (convergenceEnabled) {
      // @feature-flag:repo-grounding-remote-search-convergence enabled-start
      const error = new RepoReaderError(
        'REMOTE_SEARCH_DISABLED',
        'Broad remote repository search is disabled',
        false
      );
      // @feature-flag:repo-grounding-remote-search-convergence enabled-end
      throw error;
    }

    // @feature-flag:repo-grounding-remote-search-convergence disabled-start
    const result = await this.catalog.searchRepoCode(
      this.identity.project,
      this.identity.repo,
      query,
      this.identity.sha,
      boundedSearchLimit(limit),
      this.identity.provider
    );
    // @feature-flag:repo-grounding-remote-search-convergence disabled-end
    // @feature-flag:repo-grounding-remote-search-convergence end
    return result;
  }
}
