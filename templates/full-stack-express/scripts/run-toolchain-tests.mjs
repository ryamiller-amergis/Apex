import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(root, 'scripts', '__tests__');

function filesIn(dir) {
  const found = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) {
      found.push(...filesIn(full));
      continue;
    }
    if (name.name.endsWith('.test.mjs')) {
      found.push(full);
    }
  }
  return found;
}

const files = filesIn(testsDir);
const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('close', (status) => {
  process.exit(status ?? 1);
});
