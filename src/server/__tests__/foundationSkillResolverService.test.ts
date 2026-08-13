import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveLocalSkillPath } from '../services/foundationSkillResolverService';

describe('foundationSkillResolverService canonical roots', () => {
  it('resolves the root recorded by apex-skills.lock.json', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-resolver-test-'));
    try {
      const expected = path.join(repo, '.agents/skills/to-prd/SKILL.md');
      fs.mkdirSync(path.dirname(expected), { recursive: true });
      fs.writeFileSync(expected, '# to-prd\n');
      fs.writeFileSync(
        path.join(repo, 'apex-skills.lock.json'),
        JSON.stringify({
          skillRoot: '.agents/skills',
          suiteVersion: '2.0.3',
          skills: { 'to-prd': {} },
        })
      );

      expect(resolveLocalSkillPath('to-prd', repo)).toBe(expected);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ignores a duplicate name in a non-canonical root when a lockfile exists', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-resolver-test-'));
    try {
      for (const root of ['.agents/skills', '.cursor/skills']) {
        const skillPath = path.join(repo, root, 'to-prd/SKILL.md');
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
        fs.writeFileSync(skillPath, '# to-prd\n');
      }
      fs.writeFileSync(
        path.join(repo, 'apex-skills.lock.json'),
        JSON.stringify({
          skillRoot: '.agents/skills',
          skills: { 'to-prd': {} },
        })
      );

      expect(resolveLocalSkillPath('to-prd', repo)).toBe(
        path.join(repo, '.agents/skills/to-prd/SKILL.md')
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('prefers skills/ over .cursor/skills when no lockfile exists', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-resolver-test-'));
    try {
      const generic = path.join(repo, 'skills/to-prd/SKILL.md');
      const cursor = path.join(repo, '.cursor/skills/to-prd/SKILL.md');
      for (const skillPath of [generic, cursor]) {
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
        fs.writeFileSync(skillPath, '# to-prd\n');
      }

      expect(resolveLocalSkillPath('to-prd', repo)).toBe(generic);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps legacy .cursor discovery when no lockfile exists', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-resolver-test-'));
    try {
      const expected = path.join(repo, '.cursor/skills/to-prd/SKILL.md');
      fs.mkdirSync(path.dirname(expected), { recursive: true });
      fs.writeFileSync(expected, '# to-prd\n');

      expect(resolveLocalSkillPath('to-prd', repo)).toBe(expected);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('treats a harness symlink as an alias of the canonical catalog', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-resolver-test-'));
    try {
      const expected = path.join(repo, '.agents/skills/to-prd/SKILL.md');
      fs.mkdirSync(path.dirname(expected), { recursive: true });
      fs.writeFileSync(expected, '# to-prd\n');
      fs.mkdirSync(path.join(repo, '.cursor'), { recursive: true });
      try {
        fs.symlinkSync(
          '../.agents/skills',
          path.join(repo, '.cursor/skills'),
          'dir'
        );
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'EPERM' ||
          (error as NodeJS.ErrnoException).code === 'EACCES'
        ) {
          return;
        }
        throw error;
      }
      fs.writeFileSync(
        path.join(repo, 'apex-skills.lock.json'),
        JSON.stringify({
          skillRoot: '.agents/skills',
          skills: { 'to-prd': {} },
        })
      );

      expect(resolveLocalSkillPath('to-prd', repo)).toBe(expected);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
