import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * The interactive actor host must not open PostgreSQL. Walk the relative-import
 * graph from the three entry modules and reject db / drizzle / pg / schema and
 * any aiRunV2 module that itself imports them.
 */
const ACTOR_ROOTS = [
  resolve(__dirname, '../services/interactiveActorHost/entrypoint.ts'),
  resolve(
    __dirname,
    '../services/interactiveActorHost/interactiveSessionActorClass.ts',
  ),
  resolve(
    __dirname,
    '../services/interactiveActorHost/interactiveSessionActor.ts',
  ),
];

const FORBIDDEN_IMPORT = [
  /from ['"].*\/db\/drizzle['"]/,
  /from ['"].*\/db['"]/,
  /from ['"]pg['"]/,
  /from ['"].*\/db\/schema['"]/,
];

const FORBIDDEN_APP_SERVICE_DEADLINE = [
  'resolveAgentFirstEventTimeoutMs',
  'resolveAgentMcpToolTimeoutMs',
  'resolveGroundingPreparationTimeoutMs',
  'GROUNDING_PREPARATION_TIMEOUT_MS',
];

function relativeImports(source: string): string[] {
  const found: string[] = [];
  const pattern = /from ['"](\.[^'"]+)['"]/g;
  let match = pattern.exec(source);
  while (match) {
    found.push(match[1]);
    match = pattern.exec(source);
  }
  return found;
}

function resolveImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function collectGraph(roots: string[]): string[] {
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of relativeImports(source)) {
      const candidate = resolveImport(file, specifier);
      if (candidate) queue.push(candidate);
    }
  }
  return [...seen].sort();
}

describe('interactive actor host database isolation', () => {
  const graph = collectGraph(ACTOR_ROOTS);

  it('reaches actor-host modules and shared helpers', () => {
    expect(graph.length).toBeGreaterThan(5);
    expect(
      graph.some((file) => file.includes('interactiveCursorExecution')),
    ).toBe(true);
  });

  it.each(graph)('%s imports no database module', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_IMPORT) {
      expect(source).not.toMatch(pattern);
    }
    if (file.includes(`${join('services', 'aiRunV2')}${sep}`)) {
      // Any pulled aiRunV2 helper must itself be free of db imports.
      for (const pattern of FORBIDDEN_IMPORT) {
        expect(source).not.toMatch(pattern);
      }
    }
  });

  it('does not import App Service deadline resolvers or removed fixed constants', () => {
    for (const file of graph) {
      if (!file.includes('interactiveActorHost')) continue;
      const source = readFileSync(file, 'utf8');
      for (const name of FORBIDDEN_APP_SERVICE_DEADLINE) {
        expect(source).not.toContain(name);
      }
    }
  });
});
