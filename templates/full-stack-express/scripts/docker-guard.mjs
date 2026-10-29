import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getContainerRuntimeClient } from 'testcontainers';

const SUITES = new Set(['integration', 'e2e']);
const PROBE_LIMIT_MS = 5000;

export function dockerRequiredMessage(suite) {
  return `Docker is required to run the ${suite} tests. Start Docker, or set DOCKER_HOST to a reachable runtime, then re-run \`pnpm test:${suite}\`.`;
}

function silence(stream) {
  const original = stream.write.bind(stream);
  stream.write = () => true;
  return () => {
    stream.write = original;
  };
}

/**
 * Asks the Testcontainers runtime client for a connection. A missing runtime
 * throws the Docker message and nothing from the driver.
 */
export async function assertDockerAvailable(suite) {
  if (!SUITES.has(suite)) {
    throw new Error(
      `assertDockerAvailable: suite must be integration or e2e, received ${suite}`
    );
  }
  const restoreErr = silence(process.stderr);
  const restoreOut = silence(process.stdout);
  let available = false;
  try {
    await Promise.race([
      getContainerRuntimeClient().then(() => {
        available = true;
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), PROBE_LIMIT_MS);
      }),
    ]);
  } catch {
    available = false;
  } finally {
    restoreErr();
    restoreOut();
  }
  if (!available) {
    throw new Error(dockerRequiredMessage(suite));
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectRun()) {
  const suite = process.argv[2];
  assertDockerAvailable(suite).then(
    () => {
      process.exit(0);
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
  );
}
