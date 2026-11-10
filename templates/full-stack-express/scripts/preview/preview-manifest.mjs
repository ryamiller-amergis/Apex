import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const PREVIEW_MANIFEST_FILE = 'apex.preview.json';
export const PREVIEW_SCHEMA_VERSION = 1;

const nonEmpty = z.string().trim().min(1);
const command = z.array(nonEmpty).min(1);
const relativePath = nonEmpty.refine(
  (value) => {
    if (value.includes('\\') || value.includes('\0')) return false;
    if (path.posix.isAbsolute(value)) return false;
    const normalized = path.posix.normalize(value);
    return (
      normalized === value &&
      normalized !== '.' &&
      !normalized.startsWith('../') &&
      !normalized.includes('/../')
    );
  },
  { message: 'expected a normalized repository-relative path' }
);
const endpointPath = nonEmpty.refine(
  (value) =>
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('?') &&
    !value.includes('#'),
  { message: 'expected an absolute application path without query or fragment' }
);

const manifestSchema = z
  .object({
    schemaVersion: z.literal(PREVIEW_SCHEMA_VERSION),
    template: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        version: z
          .string()
          .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/),
      })
      .strict(),
    runner: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        version: z
          .string()
          .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/),
        dependencyLayout: z.literal('workspace-runtime-v1'),
      })
      .strict(),
    toolchain: z
      .object({
        node: nonEmpty,
        packageManager: z
          .string()
          .regex(/^pnpm@[0-9]+\.[0-9]+\.[0-9]+(?:\+sha512\.[0-9a-f]+)?$/),
      })
      .strict(),
    commands: z
      .object({
        install: command,
        build: command,
        migrate: command,
        seed: command,
        start: command,
        runtimeBundle: command,
      })
      .strict(),
    application: z
      .object({
        port: z.number().int().min(1).max(65535),
        livenessPath: endpointPath,
        readinessPath: endpointPath,
      })
      .strict(),
    development: z
      .object({
        dockerfile: relativePath,
        applicationPort: z.number().int().min(1).max(65535),
        requiredTransports: z
          .array(z.enum(['http', 'websocket', 'vite_hmr']))
          .length(3),
        tasks: z
          .object({
            typecheck: command,
            unit_test: command,
            quality_check: command,
            production_build: command,
          })
          .strict(),
      })
      .strict()
      .optional(),
    verification: z
      .object({
        journey: relativePath,
      })
      .strict(),
    allowedEnvironmentNames: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
      .min(1),
    bundle: z
      .object({
        format: z.literal('tar'),
        output: relativePath,
        sbomRef: nonEmpty,
        includes: z
          .array(
            z
              .object({
                source: relativePath,
                target: relativePath,
              })
              .strict()
          )
          .min(1),
        requiredFiles: z.array(relativePath).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const assertUnique = (values, pathPrefix, label) => {
      const seen = new Set();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: 'custom',
            path: [...pathPrefix, index],
            message: `duplicate ${label}: ${value}`,
          });
        }
        seen.add(value);
      }
    };

    assertUnique(
      manifest.allowedEnvironmentNames,
      ['allowedEnvironmentNames'],
      'environment name'
    );
    assertUnique(
      manifest.bundle.includes.map((entry) => entry.target),
      ['bundle', 'includes'],
      'bundle target'
    );
    assertUnique(
      manifest.bundle.requiredFiles,
      ['bundle', 'requiredFiles'],
      'required file'
    );
    if (manifest.development) {
      assertUnique(
        manifest.development.requiredTransports,
        ['development', 'requiredTransports'],
        'development transport'
      );
      for (const required of ['http', 'websocket', 'vite_hmr']) {
        if (!manifest.development.requiredTransports.includes(required)) {
          ctx.addIssue({
            code: 'custom',
            path: ['development', 'requiredTransports'],
            message: `missing required development transport: ${required}`,
          });
        }
      }
    }
    for (const [index, entry] of manifest.bundle.includes.entries()) {
      if (
        entry.target === PREVIEW_MANIFEST_FILE ||
        entry.target === 'apex.runtime.json'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['bundle', 'includes', index, 'target'],
          message: `reserved runtime bundle path: ${entry.target}`,
        });
      }
    }

    const sortedEnvironmentNames = [...manifest.allowedEnvironmentNames].sort();
    if (
      manifest.allowedEnvironmentNames.some(
        (name, index) => name !== sortedEnvironmentNames[index]
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedEnvironmentNames'],
        message: 'environment names must be sorted',
      });
    }
    if (
      manifest.runner.id !== manifest.template.id ||
      manifest.runner.version !== manifest.template.version
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['runner'],
        message: 'runner id and version must match the template',
      });
    }
    const expectedSbomRef = `golden-stack:${manifest.runner.id}:${manifest.runner.version}`;
    if (manifest.bundle.sbomRef !== expectedSbomRef) {
      ctx.addIssue({
        code: 'custom',
        path: ['bundle', 'sbomRef'],
        message: `expected ${expectedSbomRef}`,
      });
    }
  });

export function parsePreviewManifest(value) {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid ${PREVIEW_MANIFEST_FILE}: ${detail}`);
  }
  return result.data;
}

export async function loadPreviewManifestDocument(root) {
  const manifestPath = path.join(root, PREVIEW_MANIFEST_FILE);
  let bytes;
  try {
    const diskBytes = await readFile(manifestPath);
    bytes = Buffer.from(
      diskBytes.toString('utf8').replace(/\r\n?/g, '\n'),
      'utf8'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${PREVIEW_MANIFEST_FILE}: ${message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${PREVIEW_MANIFEST_FILE}: ${message}`);
  }
  return {
    bytes,
    manifest: parsePreviewManifest(parsed),
  };
}

export async function loadPreviewManifest(root) {
  return (await loadPreviewManifestDocument(root)).manifest;
}
