import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualityCommands } from './quality-commands.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('close', (status) => resolve(status ?? 1));
  });
}

async function chromiumReady() {
  try {
    const { chromium } = await import('@playwright/test');
    const executable = chromium.executablePath();
    return existsSync(executable);
  } catch {
    return false;
  }
}

async function dockerReady(suite) {
  const { assertDockerAvailable } = await import('./docker-guard.mjs');
  try {
    await assertDockerAvailable(suite);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(message);
    return false;
  }
}

const order = [
  'test:unit',
  'test:component',
  'test:api',
  'test:contract',
  'test:integration',
  'test:e2e',
];

for (const name of order) {
  if (name === 'test:integration' && !(await dockerReady('integration'))) {
    console.warn(
      'Skipping test:integration. Docker is required to run the integration tests.'
    );
    continue;
  }
  if (name === 'test:e2e') {
    if (!(await dockerReady('e2e'))) {
      console.warn(
        'Skipping test:e2e. Docker is required to run the e2e tests.'
      );
      continue;
    }
    if (!(await chromiumReady())) {
      console.warn(
        'Skipping test:e2e. Chromium is not installed. Run `pnpm e2e:install`, then re-run `pnpm test:e2e`.'
      );
      continue;
    }
  }
  const status = await runNode(['--run', name]);
  if (status !== 0) {
    process.exit(status);
  }
}

const toolchain = await runNode([
  path.join(root, 'scripts', 'run-toolchain-tests.mjs'),
]);
if (toolchain !== 0) {
  process.exit(toolchain);
}

const listed = qualityCommands.map((command) => command.script);
if (!listed.includes('test:contract') || !listed.includes('test:coverage')) {
  console.error('quality commands are missing a required script');
  process.exit(1);
}
