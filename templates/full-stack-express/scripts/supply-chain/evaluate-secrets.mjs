import path from 'node:path';
import { EXIT_CLEAN, EXIT_FINDINGS } from './constants.mjs';

export function relativeScanPath(filePath, root) {
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..')) {
    return filePath.split(path.sep).join('/');
  }
  return relative.split(path.sep).join('/');
}

/**
 * Keeps rule, file, and line. Drops message text and matched values.
 */
export function evaluateSecrets(report, root) {
  const lines = [];
  for (const file of report ?? []) {
    const filePath =
      root && file.filePath
        ? relativeScanPath(file.filePath, root)
        : (file.file ?? file.filePath ?? '');
    for (const message of file.messages ?? []) {
      const line = message.loc?.start?.line ?? message.line;
      lines.push(`rule ${message.ruleId} file ${filePath} line ${line}`);
    }
  }
  return {
    exitCode: lines.length === 0 ? EXIT_CLEAN : EXIT_FINDINGS,
    lines,
  };
}
