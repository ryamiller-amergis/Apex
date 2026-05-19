import { parseAutoCheckTeams } from '../services/adoTeamConfig';

describe('parseAutoCheckTeams', () => {
  it('filters retired area paths from background auto-check teams', () => {
    const teamsEnv = [
      'MaxView|MaxView',
      'MaxView|MaxView/MaxView Infra Team',
      'MaxView|MaxView/Mobile - Team',
      'OtherProject|OtherProject/Delivery',
    ].join('~~~');

    const { teams, skippedAreaPaths } = parseAutoCheckTeams(teamsEnv);

    expect(teams).toEqual([
      { project: 'MaxView', areaPath: 'MaxView' },
      { project: 'OtherProject', areaPath: 'OtherProject/Delivery' },
    ]);
    expect(skippedAreaPaths).toEqual([
      { project: 'MaxView', areaPath: 'MaxView/MaxView Infra Team' },
      { project: 'MaxView', areaPath: 'MaxView/Mobile - Team' },
    ]);
  });
});
