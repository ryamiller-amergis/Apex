import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  documentLabel,
  documentPath,
  operationKeys,
  renderOpenApiDocument,
} from './openapi-document.ts';

const text = await renderOpenApiDocument();
await mkdir(path.dirname(documentPath), { recursive: true });
await writeFile(documentPath, text);
console.log(
  `openapi:generate: wrote ${documentLabel} (${operationKeys(text).length} operations)`
);
