/**
 * One `PreflightRefusalResponse` that both the server type guard and the client
 * refusal panel must accept (VT-32).
 */
import type { PreflightRefusalResponse } from '../types/buildPreflight';

export const preflightRefusalFixture: PreflightRefusalResponse = {
  error: 'preflight_refused',
  summary: '3 things need fixing before this build can start.',
  refusals: [
    {
      code: 'code_map_missing',
      item: 'code map',
      message:
        'This repository has no code map (expected at .cursor/CODEMAP.md). A Project Admin for Apex (Build support contacts: Dana Lee) can fix this.',
      fixer: 'project_admin',
      fixerLabel: 'a Project Admin for Apex (Build support contacts: Dana Lee)',
    },
    {
      code: 'design_system_missing',
      item: 'design-system file',
      message:
        'This repository has no design-system file. A Project Admin for Apex (Build support contacts: Dana Lee) can fix this.',
      fixer: 'project_admin',
      fixerLabel: 'a Project Admin for Apex (Build support contacts: Dana Lee)',
    },
    {
      code: 'pair_not_allow_listed',
      item: 'allowed project and repository',
      message: 'This project and repository are not on the Build allow-list. A Platform Admin can fix this.',
      fixer: 'platform_admin',
      fixerLabel: 'a Platform Admin',
    },
  ],
};
