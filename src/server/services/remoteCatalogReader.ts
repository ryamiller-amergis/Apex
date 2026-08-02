import type {
  RepoDirEntry,
  RepoReader,
  RepoSearchResult,
  RepositoryIdentity,
} from '../../shared/types/repoReader';
import * as skillCatalogFacade from './skillCatalogFacade';
import { boundedSearchLimit } from './repoReader';

export interface RemoteCatalog {
  getSkillFile(
    project: string,
    repo: string,
    filePath: string,
    branch: string | undefined,
    provider: RepositoryIdentity['provider'],
  ): Promise<string>;
  listRepoDir(
    project: string,
    repo: string,
    dirPath: string,
    branch: string | undefined,
    provider: RepositoryIdentity['provider'],
  ): Promise<RepoDirEntry[]>;
  searchRepoCode(
    project: string,
    repo: string,
    query: string,
    branch: string | undefined,
    limit: number,
    provider: RepositoryIdentity['provider'],
  ): Promise<RepoSearchResult[]>;
}

export class RemoteCatalogReader implements RepoReader {
  readonly identity: RepositoryIdentity;

  constructor(
    identity: RepositoryIdentity,
    private readonly catalog: RemoteCatalog = skillCatalogFacade,
  ) {
    this.identity = { ...identity };
  }

  readFile(filePath: string): Promise<string> {
    return this.catalog.getSkillFile(
      this.identity.project,
      this.identity.repo,
      filePath,
      this.identity.sha,
      this.identity.provider,
    );
  }

  listDir(dirPath: string): Promise<RepoDirEntry[]> {
    return this.catalog.listRepoDir(
      this.identity.project,
      this.identity.repo,
      dirPath,
      this.identity.sha,
      this.identity.provider,
    );
  }

  searchCode(query: string, limit?: number): Promise<RepoSearchResult[]> {
    return this.catalog.searchRepoCode(
      this.identity.project,
      this.identity.repo,
      query,
      this.identity.sha,
      boundedSearchLimit(limit),
      this.identity.provider,
    );
  }
}
