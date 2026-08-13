import {
  isSupportedAgentSkillPath,
  normalizeSkillRoot,
  selectSkillsByRootPrecedence,
  SKILL_DISCOVERY_ROOTS,
  skillRootFromLock,
} from '../../shared/skillPaths';

describe('skillPaths', () => {
  it('pins discovery order to editor-visible catalogs first', () => {
    expect([...SKILL_DISCOVERY_ROOTS]).toEqual([
      '.agents/skills',
      '.cursor/skills',
      'skills',
    ]);
  });
  it('accepts Agent Skills and legacy discovery paths', () => {
    expect(isSupportedAgentSkillPath('.agents/skills/to-prd/SKILL.md')).toBe(
      true
    );
    expect(isSupportedAgentSkillPath('.cursor/skills/to-prd/SKILL.md')).toBe(
      true
    );
    expect(isSupportedAgentSkillPath('skills/to-prd/SKILL.md')).toBe(true);
    expect(
      isSupportedAgentSkillPath('.agents/skills/to-prd/references/extra.md')
    ).toBe(false);
  });

  it('keeps old lockfiles on the legacy root and validates configured roots', () => {
    expect(skillRootFromLock({})).toBe('.cursor/skills');
    expect(skillRootFromLock({ skillRoot: '.agents/skills' })).toBe(
      '.agents/skills'
    );
    expect(normalizeSkillRoot('./.agents/skills/')).toBe('.agents/skills');
    expect(normalizeSkillRoot('.agents/foo/../skills')).toBe('.agents/skills');
    expect(() => normalizeSkillRoot('../skills')).toThrow(
      /repository-relative/i
    );
  });

  it('prefers .agents/skills and reports duplicate names across roots', () => {
    const resolved = selectSkillsByRootPrecedence([
      {
        name: 'to-prd',
        path: '.cursor/skills/to-prd/SKILL.md',
      },
      {
        name: 'to-prd',
        path: '.agents/skills/to-prd/SKILL.md',
      },
    ]);

    expect(resolved.skills).toEqual([
      {
        name: 'to-prd',
        path: '.agents/skills/to-prd/SKILL.md',
      },
    ]);
    expect(resolved.collisions).toEqual([
      {
        name: 'to-prd',
        paths: [
          '.agents/skills/to-prd/SKILL.md',
          '.cursor/skills/to-prd/SKILL.md',
        ],
      },
    ]);
  });

  it('prefers editor-visible .cursor/skills over generic skills/', () => {
    const resolved = selectSkillsByRootPrecedence([
      {
        name: 'to-prd',
        path: '.cursor/skills/to-prd/SKILL.md',
      },
      {
        name: 'to-prd',
        path: 'skills/to-prd/SKILL.md',
      },
    ]);

    expect(resolved.skills).toEqual([
      {
        name: 'to-prd',
        path: '.cursor/skills/to-prd/SKILL.md',
      },
    ]);
  });

  it('rejects skill roots outside the known set', () => {
    expect(() => normalizeSkillRoot('company/skills')).toThrow(/one of/i);
  });
});
