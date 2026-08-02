import {
  buildRepositoryContextPack,
  extractKnownRepositoryPaths,
} from '../services/repositoryContextPack';

describe('repositoryContextPack', () => {
  const agentsContent = [
    '# Feature Map',
    '| Feature | Files |',
    '| Walkthroughs | `src/client/components/WalkthroughRenderer.tsx`, `src/server/services/walkthroughService.ts` |',
    '| Design | `.cursor/skills/grill-design/SKILL.md`, `design-docs/*.md` |',
    '',
    'Run `npm test` and check permission `admin:users`.',
    'Use route `/api/walkthroughs`.',
  ].join('\n');

  it('extracts concrete known paths while excluding commands, routes, and globs', () => {
    expect(extractKnownRepositoryPaths(agentsContent)).toEqual([
      'src/client/components/WalkthroughRenderer.tsx',
      'src/server/services/walkthroughService.ts',
      '.cursor/skills/grill-design/SKILL.md',
    ]);
  });

  it('builds a deterministic pack with source docs and exact-path guidance', () => {
    const pack = buildRepositoryContextPack({
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
      provider: 'github',
      contextContent: '# Product Context\nWalkthroughs guide users.',
      agentsContent,
    });

    expect(pack).toContain('# Pre-loaded repository context pack');
    expect(pack).toContain('## context.md');
    expect(pack).toContain('## AGENTS.md');
    expect(pack).toContain('`src/client/components/WalkthroughRenderer.tsx`');
    expect(pack).toContain('search_repo_code` is intentionally unavailable');
  });

  it('returns null when neither repository document was loaded', () => {
    expect(buildRepositoryContextPack({
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
      provider: 'ado',
    })).toBeNull();
  });
});
