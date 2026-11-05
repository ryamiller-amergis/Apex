import { existsSync } from 'node:fs';
import path from 'node:path';
import { finish, isDirect } from './cli.mjs';
import { EXIT_CANNOT_RUN, exceptionsFile, templateRoot } from './constants.mjs';
import { evaluateVulns } from './evaluate-vulns.mjs';
import { exceptionsFileSchema, loadJsonSchema } from './load-config.mjs';
import { ensureOsvScanner } from './osv-scanner.mjs';
import { parseJsonText } from './parse-json.mjs';
import { runCommand } from './run-command.mjs';

export async function runVulnerabilityScan(options = {}) {
  const root = options.root ?? templateRoot;
  const lockfile = path.join(root, 'pnpm-lock.yaml');
  const loaded = loadJsonSchema(
    options.exceptionsFile ?? exceptionsFile,
    exceptionsFileSchema
  );
  if (!loaded.ok) {
    return { exitCode: EXIT_CANNOT_RUN, lines: [loaded.message] };
  }
  if (!existsSync(lockfile)) {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['pnpm-lock.yaml is missing'],
    };
  }
  const scan =
    options.scanLockfile ??
    (async () => {
      const scanner = await ensureOsvScanner({
        root: options.toolRoot ?? templateRoot,
      });
      return runCommand(
        scanner,
        [
          'scan',
          'source',
          '-L',
          lockfile,
          '--format',
          'json',
          '--verbosity',
          'error',
        ],
        { cwd: root, env: options.env ?? process.env }
      );
    });
  let result;
  try {
    result = await scan();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'vulnerability scan could not run';
    return { exitCode: EXIT_CANNOT_RUN, lines: [message] };
  }
  if (!result || result.error || result.stdout.trim() === '') {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['vulnerability scan could not run'],
    };
  }
  let report;
  try {
    report = parseJsonText(result.stdout);
  } catch {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['vulnerability scan could not run'],
    };
  }
  return evaluateVulns(report, loaded.data, { today: options.today });
}

if (isDirect(import.meta.url)) {
  finish(await runVulnerabilityScan());
}
