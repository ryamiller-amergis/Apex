import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qualityCommands } from '../quality-commands.mjs';
import { templateRootDir } from './runFixture.ts';

function packageJson(): { scripts: Record<string, string> } {
  return JSON.parse(
    readFileSync(path.join(templateRootDir, 'package.json'), 'utf8')
  ) as { scripts: Record<string, string> };
}

describe('script surface (VT-32)', () => {
  it('VT-32 every quality command is a package script, and contract is included', () => {
    const scripts = packageJson().scripts;
    for (const command of qualityCommands) {
      expect(scripts[command.script], command.script).toBeTruthy();
    }
    expect(scripts['test:contract']).toMatch(/contract/);
  });

  it('VT-32 the Testing section names every test script and leaves the schedule to each team', () => {
    const readme = readFileSync(
      path.join(templateRootDir, 'README.md'),
      'utf8'
    );
    const section = readme.split('## Testing')[1]?.split('\n## ')[0] ?? '';
    expect(section.length).toBeGreaterThan(0);
    expect(section).toMatch(/each team decides when/i);
    const scripts = packageJson().scripts;
    for (const name of Object.keys(scripts)) {
      if (name.startsWith('test') || name.startsWith('e2e:')) {
        expect(section, name).toContain(`\`${name}\``);
      }
    }
  });
});
