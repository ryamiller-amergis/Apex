import { createTwoFilesPatch } from 'diff';
import { readFile } from 'node:fs/promises';
import {
  documentLabel,
  documentPath,
  operationKeys,
  renderOpenApiDocument,
  validateOpenApiDocument,
} from './openapi-document.ts';

const regenerate = 'Run "pnpm openapi:generate" and commit the result.';

async function readCommitted(): Promise<string | undefined> {
  try {
    return await readFile(documentPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function difference(left: string[], right: string[]): string {
  const missing = left.filter((key) => !right.includes(key)).sort();
  return missing.length > 0 ? missing.join(', ') : 'none';
}

async function check(): Promise<number> {
  const fresh = await renderOpenApiDocument();
  const committed = await readCommitted();
  if (committed === undefined) {
    console.error(`openapi:check: ${documentLabel} is missing. ${regenerate}`);
    return 1;
  }
  if (committed !== fresh) {
    console.log(
      createTwoFilesPatch(
        `${documentLabel} (committed)`,
        `${documentLabel} (generated)`,
        committed,
        fresh
      )
    );
    const committedKeys = operationKeys(committed);
    const freshKeys = operationKeys(fresh);
    console.error(
      [
        `openapi:check: ${documentLabel} is stale.`,
        `Missing from the committed file: ${difference(freshKeys, committedKeys)}.`,
        `Not in the route definitions: ${difference(committedKeys, freshKeys)}.`,
        regenerate,
      ].join(' ')
    );
    return 1;
  }
  const problems = await validateOpenApiDocument(committed);
  if (problems.length > 0) {
    console.error(
      `openapi:check: ${documentLabel} is not valid OpenAPI 3.1:\n${problems.join('\n')}`
    );
    return 1;
  }
  console.log(
    `openapi:check: ${documentLabel} matches the route definitions and is valid OpenAPI 3.1`
  );
  return 0;
}

process.exitCode = await check();
