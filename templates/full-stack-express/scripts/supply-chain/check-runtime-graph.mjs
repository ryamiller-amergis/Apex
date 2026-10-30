import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Imports every relative module of dist/index.js without executing that
 * file. dist/index.js listens as soon as it loads, so the image build
 * checks the module graph through its imports instead.
 */
export async function checkRuntimeGraph(packageDir) {
  const entry = path.join(packageDir, 'dist', 'index.js');
  let source;
  try {
    source = readFileSync(entry, 'utf8');
  } catch {
    throw new Error(`runtime graph check could not read ${entry}`);
  }
  const specifiers = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(
    (match) => match[1]
  );
  if (specifiers.length === 0) {
    throw new Error('runtime graph check found no imports in dist/index.js');
  }
  for (const specifier of specifiers) {
    const file = path.resolve(path.dirname(entry), specifier);
    await import(pathToFileURL(file).href);
  }
}

async function main() {
  const packageDir = process.argv[2];
  if (!packageDir) {
    process.stderr.write(
      'runtime graph check could not run: pass the deployed package directory\n'
    );
    process.exit(2);
  }
  try {
    await checkRuntimeGraph(packageDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'import failed';
    process.stderr.write(`runtime graph check could not run: ${message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
