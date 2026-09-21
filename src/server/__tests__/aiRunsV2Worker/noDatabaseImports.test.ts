import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * A worker image must not open a PostgreSQL connection — that is the point of
 * the V2 split. Walk the whole relative-import graph rather than one folder,
 * because a single shared helper is enough to pull the pool in.
 */
const WORKER_DIR = resolve(__dirname, '../../services/aiRunsV2Worker');

const FORBIDDEN = [/from '.*\/db\/drizzle'/, /from '.*\/db'/, /from 'pg'/];

function relativeImports(source: string): string[] {
  const found: string[] = [];
  const pattern = /from '(\.[^']+)'/g;
  let match = pattern.exec(source);
  while (match) {
    found.push(match[1]);
    match = pattern.exec(source);
  }
  return found;
}

function collectGraph(): string[] {
  const queue = readdirSync(WORKER_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(WORKER_DIR, name));
  const seen = new Set<string>();

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
      const candidate = resolve(dirname(file), `${specifier}.ts`);
      if (existsSync(candidate)) queue.push(candidate);
    }
  }
  return [...seen].sort();
}

describe('V2 worker isolation', () => {
  const graph = collectGraph();

  it('reaches the worker modules and their shared helpers', () => {
    expect(graph.length).toBeGreaterThan(5);
    expect(graph.some((file) => file.includes('artifactContainer'))).toBe(true);
  });

  it.each(graph)('%s imports no database module', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      expect(source).not.toMatch(pattern);
    }
  });
});
