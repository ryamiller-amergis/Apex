/**
 * Fails when .cursor/CODEMAP.md lists a repo path that no longer exists.
 *
 * Only backticked paths under CHECKED_ROOTS are verified; placeholders and
 * patterns (<slug>, *, {a,b}) and bare file names are skipped, so write
 * codemap entries as full repo-relative paths to have them checked.
 */
import { existsSync, readFileSync } from 'node:fs';

const CODEMAP = '.cursor/CODEMAP.md';
const CHECKED_ROOTS = [
  'src/',
  'tests/',
  'migrations/',
  'scripts/',
  'infra/',
  'runners/',
  'foundation-skills/',
  'docs/',
  'design-docs/',
  'public/',
  'teams-app/',
  '.github/',
  '.cursor/',
];

if (!existsSync(CODEMAP)) process.exit(0);

const listedPaths = [...readFileSync(CODEMAP, 'utf8').matchAll(/`([^`\s]+)`/g)]
  .map(([, path]) => path)
  .filter(
    (path) =>
      CHECKED_ROOTS.some((root) => path.startsWith(root)) &&
      !/[<>*{}]/.test(path)
  );

const uniquePaths = [...new Set(listedPaths)];
const missing = uniquePaths.filter((path) => !existsSync(path));

if (missing.length > 0) {
  console.error(
    `${CODEMAP} lists paths that no longer exist:\n${missing.map((path) => `  - ${path}`).join('\n')}\nUpdate ${CODEMAP} in this change.`
  );
  process.exit(1);
}

console.log(`${CODEMAP}: ${uniquePaths.length} paths OK`);
