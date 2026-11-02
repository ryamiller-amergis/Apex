import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifests } from './lib/manifests.mjs';
import { formatReport } from './lib/report.mjs';

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

function readRoot(argv) {
  const index = argv.indexOf('--root');
  if (index === -1) {
    return defaultRoot;
  }
  const value = argv[index + 1];
  if (!value) {
    console.error('quality:validate: --root needs a directory');
    process.exit(2);
  }
  return path.resolve(value);
}

const result = await validateManifests(readRoot(process.argv.slice(2)));
console.log(formatReport(result).join('\n'));
process.exitCode = result.errors.length > 0 ? 1 : 0;
