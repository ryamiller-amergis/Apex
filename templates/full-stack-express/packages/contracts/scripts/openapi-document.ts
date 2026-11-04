import { compileErrors, validate } from '@readme/openapi-parser';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import type { AnyRoute } from '../src/define-route.ts';
import { buildOpenApiDocument } from '../src/openapi/build-document.ts';
import { routeKey, routeList } from '../src/registry.ts';

export const documentLabel = 'openapi/openapi.json';
export const documentPath = fileURLToPath(
  new URL('../openapi/openapi.json', import.meta.url)
);

// Fixed options so the file formats the same whichever Prettier config a
// host repository resolves for it.
const prettierOptions = { parser: 'json', printWidth: 80, tabWidth: 2 };

export function renderOpenApiDocument(
  routes: readonly AnyRoute[] = routeList
): Promise<string> {
  return format(
    JSON.stringify(buildOpenApiDocument(routes), null, 2),
    prettierOptions
  );
}

export function operationKeys(text: string): string[] {
  let paths: Record<string, Record<string, unknown>>;
  try {
    paths = (JSON.parse(text) as { paths?: typeof paths }).paths ?? {};
  } catch {
    return [];
  }
  const fromOpenApiPath = (path: string) =>
    path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, ':$1');
  return Object.entries(paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) =>
      routeKey({ method, path: fromOpenApiPath(path) })
    )
  );
}

export async function validateOpenApiDocument(text: string): Promise<string[]> {
  let document: { openapi?: unknown };
  try {
    document = JSON.parse(text) as typeof document;
  } catch {
    return [`${documentLabel} is not valid JSON`];
  }
  if (!String(document.openapi).startsWith('3.1')) {
    return [
      `${documentLabel} declares openapi ${String(document.openapi)}; expected 3.1`,
    ];
  }
  const result = await validate(document as Parameters<typeof validate>[0]);
  return result.valid ? [] : [compileErrors(result)];
}
