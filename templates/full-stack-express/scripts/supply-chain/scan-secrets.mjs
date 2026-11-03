import { existsSync } from 'node:fs';
import path from 'node:path';
import { finish, isDirect } from './cli.mjs';
import {
  EXIT_CANNOT_RUN,
  secretlintConfigFile,
  templateRoot,
} from './constants.mjs';
import { evaluateSecrets } from './evaluate-secrets.mjs';
import { parseJsonText } from './parse-json.mjs';
import { runCommand } from './run-command.mjs';
import { isSecretScanIgnored, loadIgnorePatterns } from './secret-ignore.mjs';

export async function listTrackedFiles(root) {
  const result = await runCommand(
    'git',
    ['-C', root, 'ls-files', '-z', '--', '.'],
    { cwd: root }
  );
  if (result.error || result.status !== 0) {
    return { ok: false };
  }
  const files = result.stdout
    .split('\0')
    .filter((file) => file !== '' && existsSync(path.join(root, file)));
  return { ok: true, files };
}

export async function runSecretScan(options = {}) {
  const root = options.root ?? templateRoot;
  const config = options.config ?? secretlintConfigFile;
  let files = options.files;
  if (!files) {
    const tracked = await listTrackedFiles(root);
    if (!tracked.ok) {
      return {
        exitCode: EXIT_CANNOT_RUN,
        lines: ['secret scan could not run: git file list failed'],
      };
    }
    const patterns = options.ignorePatterns ?? loadIgnorePatterns();
    files = tracked.files.filter(
      (file) => !isSecretScanIgnored(file, patterns)
    );
  }
  if (files.length === 0) {
    return evaluateSecrets([], root);
  }
  const secretlint = path.join(
    options.toolRoot ?? templateRoot,
    'node_modules',
    'secretlint',
    'bin',
    'secretlint.js'
  );
  const args = [
    secretlint,
    '--format',
    'json',
    '--no-glob',
    '--secretlintrc',
    config,
    ...files.map((file) => path.resolve(root, file)),
  ];
  const result = await runCommand(process.execPath, args, {
    cwd: root,
    env: options.env ?? process.env,
  });
  if (result.error || result.stdout.trim() === '') {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['secret scan could not run'],
    };
  }
  let report;
  try {
    report = parseJsonText(result.stdout);
  } catch {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['secret scan could not run'],
    };
  }
  return evaluateSecrets(report, root);
}

if (isDirect(import.meta.url)) {
  finish(await runSecretScan());
}
