import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TokenOverrides } from '../tokens/index.js';
import { checkThemeContrast, formatContrastFailure } from './contrast.js';

export interface ContrastCliDeps {
  log?: (line: string) => void;
  cwd?: string;
}

async function loadOverrides(file: string): Promise<TokenOverrides> {
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(file).href
  )) as {
    default?: TokenOverrides;
    overrides?: TokenOverrides;
  };
  return module.default ?? module.overrides ?? {};
}

/**
 * Runs the contrast check and returns the exit code: 0 when every pairing
 * passes, 1 when any fails, 2 for a usage error. `--overrides <path>` loads a
 * module whose default (or `overrides`) export is a `TokenOverrides` object.
 */
export async function runContrastCli(
  argv: readonly string[],
  { log = console.log, cwd = process.cwd() }: ContrastCliDeps = {}
): Promise<number> {
  let overrides: TokenOverrides | undefined;
  const flag = argv.indexOf('--overrides');
  if (flag !== -1) {
    const file = argv[flag + 1];
    if (!file) {
      log('check:contrast: --overrides needs a module path');
      return 2;
    }
    overrides = await loadOverrides(path.resolve(cwd, file));
  }
  const failures = checkThemeContrast(overrides);
  if (failures.length === 0) {
    log('check:contrast: light and dark themes pass WCAG 2.1 AA');
    return 0;
  }
  for (const failure of failures) {
    log(formatContrastFailure(failure));
  }
  return 1;
}
