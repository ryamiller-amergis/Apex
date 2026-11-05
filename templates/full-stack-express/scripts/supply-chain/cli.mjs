import { pathToFileURL } from 'node:url';
import { EXIT_CANNOT_RUN } from './constants.mjs';

export function isDirect(metaUrl) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return metaUrl === pathToFileURL(entry).href;
}

export function finish(result) {
  const text = result.lines.filter((line) => line !== '').join('\n');
  if (text !== '') {
    const stream =
      result.exitCode === EXIT_CANNOT_RUN ? process.stderr : process.stdout;
    stream.write(`${text}\n`);
  }
  process.exit(result.exitCode);
}
