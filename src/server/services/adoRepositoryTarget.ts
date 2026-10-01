/**
 * Skill settings store an ADO repo as "Project/repo" when the Apex project
 * name is not the Azure DevOps project. Git and file APIs need those split.
 */
export function resolveAdoRepository(
  project: string,
  repo: string,
): { project: string; repo: string } {
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) return { project, repo };
  const adoProject = repo.slice(0, slash).trim();
  const adoRepo = repo.slice(slash + 1).trim();
  if (!adoProject || !adoRepo) return { project, repo };
  return { project: adoProject, repo: adoRepo };
}
