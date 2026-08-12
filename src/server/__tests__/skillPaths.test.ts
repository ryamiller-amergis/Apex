import {
  isSupportedAgentSkillPath,
  normalizeSkillRoot,
  selectSkillsByRootPrecedence,
  skillRootFromLock,
} from '../../shared/skillPaths';

describe('skillPaths', () => {
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
});
