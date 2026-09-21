import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A worker image must not open a PostgreSQL connection — that is the point of
 * the V2 split. Guard the whole module directory, not just the entrypoints,
 * because any import in the graph would pull the pool in.
 */
const WORKER_DIR = join(__dirname, '../../services/aiRunsV2Worker');

const FORBIDDEN = [/from '.*\/db\/drizzle'/, /from '.*\/db'/, /from 'pg'/];

describe('V2 worker isolation', () => {
  const files = readdirSync(WORKER_DIR).filter((name) => name.endsWith('.ts'));

  it('has worker modules to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s imports no database module', (file) => {
    const source = readFileSync(join(WORKER_DIR, file), 'utf8');
    for (const pattern of FORBIDDEN) {
      expect(source).not.toMatch(pattern);
    }
  });
});
