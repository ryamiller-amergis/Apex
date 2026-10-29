jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn() }));
jest.mock('../services/buildAccessService', () => ({ isBuildPairAllowed: jest.fn() }));
jest.mock('../services/userProjectAssignmentService', () => ({ getAssignmentsForProject: jest.fn() }));
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfigById: jest.fn(),
  listSkillConfigsForProject: jest.fn(),
}));

import fs from 'fs';
import path from 'path';
import { runPreflight, type PreflightPorts } from '../services/buildPreflight';
import { BUILD_PROFILE_ROLES } from '../../shared/types/build';
import { emptyBuildProfile } from '../../shared/types/buildPreflight';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';

const starterRoot = path.resolve(__dirname, '../../../foundation-skills/starters/react-mui-express');

/** Starter file → the path a Project Admin copies it to in the target repository. */
const STARTER_TARGETS: Record<string, string> = {
  'design-system/SKILL.md': '.cursor/skills/design-system/SKILL.md',
  'rules/react-mui-express.mdc': '.cursor/rules/react-mui-express.mdc',
  'CODEMAP.md': '.cursor/CODEMAP.md',
};

function starterFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [source, target] of Object.entries(STARTER_TARGETS)) {
    files[target] = fs.readFileSync(path.join(starterRoot, source), 'utf8');
  }
  return files;
}

describe('TBI-006 DoD-3 — React + MUI on Express starter templates (VT-29)', () => {
  it('ships the design-system, coding-rules and code-map templates', () => {
    for (const source of Object.keys(STARTER_TARGETS)) {
      expect(fs.existsSync(path.join(starterRoot, source))).toBe(true);
    }
  });

  it('the design-system template names MUI, tokens, icon set, page layout and accessibility baseline', () => {
    const text = fs.readFileSync(path.join(starterRoot, 'design-system/SKILL.md'), 'utf8');
    for (const heading of ['MUI', 'Tokens', 'Icon set', 'Page layout', 'Accessibility baseline']) {
      expect(text).toMatch(new RegExp(`^## .*${heading}`, 'm'));
    }
  });

  it('copied into a repository, the templates pass the design-system, coding-rules and code-map checks', async () => {
    const files = starterFiles();
    const profile = emptyBuildProfile();
    for (const role of BUILD_PROFILE_ROLES) profile.roles[role] = { skillPath: `.cursor/skills/${role}/SKILL.md`, model: 'm' };
    const row = { id: 'r', project: 'P', skillRepo: 'app', skillBranch: 'main', skillProvider: 'ado', buildProfile: profile } as ProjectSkillConfig;
    const ports: PreflightPorts = {
      loadSettings: async () => row,
      isPairAllowed: async () => true,
      isFlagEnabled: async () => true,
      listAssignedUsers: async () => new Map(),
      readFile: async (_c, p) => files[p] ?? null,
      listFolder: async (_c, folder) => {
        const found = Object.keys(files).filter((p) => p.startsWith(`${folder}/`));
        return found.length ? found : null;
      },
      readPipeline: async () => null,
      redact: (t) => t,
      now: () => new Date(),
      log: () => undefined,
    };
    const result = await runPreflight({ project: 'P', repository: 'app', userId: 'u' }, ports);
    expect(result.ok).toBe(false);
    const codes = result.ok ? [] : result.refusals.map((r) => r.code);
    expect(codes).not.toContain('design_system_missing');
    expect(codes).not.toContain('coding_rules_missing');
    expect(codes).not.toContain('code_map_missing');
  });
});
