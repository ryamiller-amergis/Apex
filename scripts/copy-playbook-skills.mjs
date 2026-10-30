/**
 * Copies playbook-skills into dist so a deploy that only ships the build output
 * still has the Agent task Skill list. The quick dev workflow on main does that.
 */
import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve('playbook-skills');
const destination = path.resolve('dist', 'playbook-skills');

if (!fs.existsSync(source)) {
  console.error('playbook-skills was not found next to package.json');
  process.exit(1);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
console.log(`Copied playbook-skills to ${destination}`);
