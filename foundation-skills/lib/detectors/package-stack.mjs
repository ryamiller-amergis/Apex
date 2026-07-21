/**
 * Package / tech-stack detector
 *
 * Reads package.json (and nested ClientApp/package.json, mobile-app/package.json)
 * to identify the primary tech stack, frameworks, and tool versions.
 *
 * Emits evidence:
 *   { type: 'dep',       name: 'react',           version: '^18.2.0', dev: false, file: 'package.json',           line: 1 }
 *   { type: 'framework', name: 'express',          version: '^4.18.2', file: 'package.json',           line: 1 }
 *   { type: 'framework', name: 'react',            version: '^18.2.0', file: 'package.json',           line: 1 }
 *   { type: 'engine',    name: 'node',             value:  '>=18',     file: 'package.json',           line: 1 }
 *   { type: 'script',    name: 'build',            command: 'vite build', file: 'package.json',        line: 1 }
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FRAMEWORK_KEYS = new Set([
  'react', 'react-dom', 'next', 'nuxt', 'vue', 'svelte', 'angular',
  'express', 'fastify', 'koa', 'hapi',
  '@mui/material', 'antd', 'tailwindcss',
  'drizzle-orm', 'typeorm', 'prisma', 'mongoose',
  'vitest', 'jest', '@testing-library/react',
]);

const PKG_LOCATIONS = ['package.json', 'src/Maxim.TimeClock.Web/ClientApp/package.json', 'ClientApp/package.json', 'mobile-app/package.json', 'mobile-App/package.json'];

function readPkg(repoRoot, rel) {
  const abs = join(repoRoot, rel);
  if (!existsSync(abs)) return null;
  try { return { data: JSON.parse(readFileSync(abs, 'utf-8')), file: rel }; } catch { return null; }
}

/**
 * @param {string} repoRoot
 * @returns {Array<{type: string, name: string, version?: string, value?: string, command?: string, dev: boolean, file: string, line: number}>}
 */
export function detectStack(repoRoot) {
  const evidence = [];

  for (const rel of PKG_LOCATIONS) {
    const result = readPkg(repoRoot, rel);
    if (!result) continue;
    const { data, file } = result;

    // Engines
    for (const [k, v] of Object.entries(data.engines ?? {})) {
      evidence.push({ type: 'engine', name: k, value: v, file, line: 1 });
    }

    // Scripts
    for (const [name, command] of Object.entries(data.scripts ?? {})) {
      evidence.push({ type: 'script', name, command, file, line: 1 });
    }

    // Dependencies
    const allDeps = { ...data.dependencies, ...data.devDependencies };
    const devSet = new Set(Object.keys(data.devDependencies ?? {}));
    for (const [name, version] of Object.entries(allDeps)) {
      const isDev = devSet.has(name);
      evidence.push({ type: 'dep', name, version, dev: isDev, file, line: 1 });
      if (FRAMEWORK_KEYS.has(name)) {
        evidence.push({ type: 'framework', name, version, file, line: 1 });
      }
    }
  }

  return evidence;
}
