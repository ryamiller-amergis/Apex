import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeBundle } from './runtime-bundle.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);

try {
  const result = await buildRuntimeBundle({ root });
  process.stdout.write(
    `${JSON.stringify({
      output: path.relative(root, result.outputPath).split(path.sep).join('/'),
      digest: result.digest,
      sizeBytes: result.sizeBytes,
    })}\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Runtime bundle failed: ${message}\n`);
  process.exitCode = 1;
}
