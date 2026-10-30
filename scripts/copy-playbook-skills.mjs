/**
 * Copies foundation skills into dist so a deploy that only ships the build output
 * still has the Agent task Skill list. The quick dev workflow on main does that.
 */
import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve('foundation-skills', 'foundation');
const destination = path.resolve('dist', 'foundation-skills', 'foundation');

if (!fs.existsSync(source)) {
  console.error('foundation-skills/foundation was not found next to package.json');
  process.exit(1);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.cpSync(source, destination, { recursive: true });
console.log(`Copied foundation skills to ${destination}`);
