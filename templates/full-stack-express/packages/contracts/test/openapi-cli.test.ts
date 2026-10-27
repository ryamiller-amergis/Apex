import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

let workDir: string;

function run(script: 'check-openapi' | 'generate-openapi') {
  const result = spawnSync(
    process.execPath,
    [path.join('scripts', `${script}.ts`)],
    { cwd: workDir, encoding: 'utf8' }
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

const putThingSource = `
const putThing = defineRoute({
  id: 'putThing',
  method: 'put',
  path: '/api/v1/things',
  auth: 'principal',
  summary: 'Replace things',
  request: { body: z.strictObject({ nickname: z.string().min(2).max(20).optional() }) },
  responses: { 204: { description: 'Replaced' } },
});
`;

async function addPutThingRoute() {
  const registryPath = path.join(workDir, 'src', 'registry.ts');
  const source = await readFile(registryPath, 'utf8');
  const updated = source.replace(
    'export const routes = {',
    `${putThingSource}\nexport const routes = {\n  putThing,`
  );
  expect(updated).not.toBe(source);
  await writeFile(
    registryPath,
    `import { z } from 'zod';\nimport { defineRoute } from './define-route.ts';\n${updated}`
  );
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'contracts-openapi-'));
  for (const entry of ['package.json', 'src', 'scripts', 'openapi']) {
    await cp(path.join(packageRoot, entry), path.join(workDir, entry), {
      recursive: true,
    });
  }
  await symlink(
    path.join(packageRoot, 'node_modules'),
    path.join(workDir, 'node_modules'),
    'junction'
  );
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('openapi:check and openapi:generate (VT-03, VT-07)', () => {
  it('TBI-010 DoD-3 / VT-07 passes on the committed document, which is valid OpenAPI 3.1', () => {
    const result = run('check-openapi');
    expect(result.output).toContain('valid OpenAPI 3.1');
    expect(result.status).toBe(0);
  });

  it('PBI-006 AC-1 / PBI-007 AC-1 / TBI-010 DoD-1 fails with a diff that names the route missing from the committed file', async () => {
    await addPutThingRoute();
    const result = run('check-openapi');
    expect(result.status).toBe(1);
    expect(result.output).toContain('--- openapi/openapi.json (committed)');
    expect(result.output).toContain('+++ openapi/openapi.json (generated)');
    expect(result.output).toMatch(/^\+\s+"put": \{$/m);
    expect(result.output).toContain(
      'Missing from the committed file: PUT /api/v1/things'
    );
    expect(result.output).toContain('pnpm openapi:generate');
  });

  it('TBI-010 DoD-0 generate writes the committed document, after which the check passes', async () => {
    const generated = run('generate-openapi');
    expect(generated.status).toBe(0);
    expect(generated.output).toContain('wrote openapi/openapi.json');
    const document = JSON.parse(
      await readFile(path.join(workDir, 'openapi', 'openapi.json'), 'utf8')
    ) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(document.paths['/api/v1/things'] ?? {})).toEqual([
      'put',
    ]);
    expect(run('check-openapi').status).toBe(0);
  });

  it('TBI-010 DoD-3 fails with validator messages when the committed file is not valid OpenAPI 3.1', async () => {
    const documentPath = path.join(workDir, 'openapi', 'openapi.json');
    const original = await readFile(documentPath, 'utf8');
    const { validateOpenApiDocument } =
      await import('../scripts/openapi-document.ts');
    const broken = JSON.parse(original) as { openapi: string; info: object };
    broken.info = {};
    expect(
      (await validateOpenApiDocument(JSON.stringify(broken))).join('\n')
    ).toMatch(/title|version/);
    broken.openapi = '3.0.3';
    expect(
      (await validateOpenApiDocument(JSON.stringify(broken))).join('\n')
    ).toContain('3.1');
  });

  it('TBI-010 DoD-1 reports a missing committed document', async () => {
    await rm(path.join(workDir, 'openapi', 'openapi.json'));
    const result = run('check-openapi');
    expect(result.status).toBe(1);
    expect(result.output).toContain('openapi/openapi.json is missing');
  });
});
