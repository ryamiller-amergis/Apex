export interface ConfiguredAdoTeam {
  project: string;
  areaPath: string;
}

const RETIRED_AUTO_CHECK_AREA_PATHS = new Set([
  'maxview/maxview infra team',
  'maxview/mobile - team',
]);

function normalizeAreaPath(areaPath: string): string {
  return areaPath.trim().replace(/\\/g, '/').toLowerCase();
}

export function isRetiredAutoCheckAreaPath(areaPath: string): boolean {
  return RETIRED_AUTO_CHECK_AREA_PATHS.has(normalizeAreaPath(areaPath));
}

export function parseAutoCheckTeams(teamsEnv = process.env.VITE_TEAMS || ''): {
  teams: ConfiguredAdoTeam[];
  skippedAreaPaths: ConfiguredAdoTeam[];
} {
  const teams: ConfiguredAdoTeam[] = [];
  const skippedAreaPaths: ConfiguredAdoTeam[] = [];

  teamsEnv.split('~~~').forEach((team) => {
    const [project, areaPath] = team.trim().split('|');
    if (!project || !areaPath) return;

    const configuredTeam = { project, areaPath };
    if (isRetiredAutoCheckAreaPath(areaPath)) {
      skippedAreaPaths.push(configuredTeam);
      return;
    }

    teams.push(configuredTeam);
  });

  return { teams, skippedAreaPaths };
}
