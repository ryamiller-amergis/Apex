import fs from 'node:fs';
import path from 'node:path';

const CLIENT_ROOT = path.join(__dirname, '..');
const ALLOWED = new Set([
  path.normalize(path.join(CLIENT_ROOT, 'components', 'PlaybookCanvas.tsx')),
  path.normalize(path.join(CLIENT_ROOT, 'utils', 'playbookCanvasLayout.ts')),
]);

const FORBIDDEN = ['@xyflow/react', 'elkjs'];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walk(full, files);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('playbook canvas import boundary', () => {
  it('only PlaybookCanvas and playbookCanvasLayout may import xyflow or elkjs', () => {
    const violations: string[] = [];
    for (const file of walk(CLIENT_ROOT)) {
      const normalized = path.normalize(file);
      const text = fs.readFileSync(file, 'utf8');
      const usesForbidden = FORBIDDEN.some((pkg) => text.includes(pkg));
      if (!usesForbidden) continue;
      if (!ALLOWED.has(normalized)) {
        violations.push(path.relative(CLIENT_ROOT, normalized));
      }
    }
    expect(violations).toEqual([]);
  });
});
