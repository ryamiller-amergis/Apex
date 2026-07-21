import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/** Create a temp repo fixture with the given files. Returns its absolute path. */
export function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-skills-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return root;
}

export function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

export const SAMPLE_REPO = {
  'package.json': JSON.stringify({ name: 'project-blue', dependencies: { react: '^18.0.0', vite: '^5.0.0' } }),
  'src/styles/theme.css': ':root {\n  --color-primary: #2b6cb0;\n  --text-primary: #1a202c;\n  --border-color: #e2e8f0;\n}\n',
  'src/client/components/ShiftCard.tsx': 'export const ShiftCard = () => null;\n',
  'src/client/components/UserBadge.tsx': 'export const UserBadge = () => null;\n',
};
