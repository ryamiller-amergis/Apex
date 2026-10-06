export interface ProductBuildArtifactChange {
  path: string;
  content: string;
}

export function filterChangedProductBuildArtifacts(
  changes: ProductBuildArtifactChange[],
  remoteContentByPath: ReadonlyMap<string, string | null | undefined>,
): ProductBuildArtifactChange[] {
  return changes.filter((change) => {
    const remote = remoteContentByPath.get(change.path);
    return remote === undefined || remote === null || remote !== change.content;
  });
}

export async function pushProductBuildArtifacts(
  input: {
    repoName: string;
    branch: string;
    changes: ProductBuildArtifactChange[];
  },
  deps: {
    readRepositoryFile: (repoName: string, branch: string, path: string) => Promise<string | null>;
    pushFiles: (input: {
      repoName: string;
      branch: string;
      changes: ProductBuildArtifactChange[];
    }) => Promise<void>;
  },
): Promise<void> {
  const remoteContentByPath = new Map<string, string | null>();
  for (const change of input.changes) {
    remoteContentByPath.set(
      change.path,
      await deps.readRepositoryFile(input.repoName, input.branch, change.path),
    );
  }
  const changed = filterChangedProductBuildArtifacts(input.changes, remoteContentByPath);
  if (changed.length === 0) return;
  await deps.pushFiles({
    repoName: input.repoName,
    branch: input.branch,
    changes: changed,
  });
}
