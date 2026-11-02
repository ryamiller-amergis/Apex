import { finish, isDirect } from './cli.mjs';
import {
  EXIT_CANNOT_RUN,
  allowedLicensesFile,
  templateRoot,
} from './constants.mjs';
import {
  evaluateLicenses,
  packagesFromLicenseReport,
} from './evaluate-licenses.mjs';
import { allowedLicensesSchema, loadJsonSchema } from './load-config.mjs';
import { parseJsonText } from './parse-json.mjs';
import { runCommand } from './run-command.mjs';

export async function runLicenseScan(options = {}) {
  const root = options.root ?? templateRoot;
  const loaded = loadJsonSchema(
    options.allowedLicensesFile ?? allowedLicensesFile,
    allowedLicensesSchema
  );
  if (!loaded.ok) {
    return { exitCode: EXIT_CANNOT_RUN, lines: [loaded.message] };
  }
  const result =
    options.licenseReport ??
    (await runCommand(
      'corepack',
      ['pnpm', 'licenses', 'list', '--prod', '--json'],
      { cwd: root, env: options.env ?? process.env }
    ));
  if (result.error || result.status !== 0 || result.stdout.trim() === '') {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['license check could not run'],
    };
  }
  let report;
  try {
    report = parseJsonText(result.stdout);
  } catch {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['license check could not run'],
    };
  }
  return evaluateLicenses(packagesFromLicenseReport(report), loaded.data);
}

if (isDirect(import.meta.url)) {
  finish(await runLicenseScan());
}
