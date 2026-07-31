import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const packageRoot = path.join(
  repoRoot,
  'node_modules',
  '@pdftron',
  'webviewer'
);
const source = path.join(packageRoot, 'public');
const target = path.join(repoRoot, 'public', 'apryse-webviewer', 'lib');
const marker = path.join(target, '.apryse-version');

const packageJson = JSON.parse(
  await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')
);
const expectedVersion = String(packageJson.version);

try {
  const installedVersion = (await fs.readFile(marker, 'utf8')).trim();
  if (installedVersion === expectedVersion) {
    console.log(`Apryse WebViewer assets ${expectedVersion} are current.`);
    process.exit(0);
  }
} catch {
  // Missing or stale marker: refresh the generated public assets.
}

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.cp(source, target, { recursive: true });
await fs.writeFile(marker, `${expectedVersion}\n`, 'utf8');
console.log(`Copied Apryse WebViewer assets ${expectedVersion}.`);
