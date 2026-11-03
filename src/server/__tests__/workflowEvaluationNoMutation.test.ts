/**
 * TBI-001 (d) / VT-07 — no server code updates or deletes an evaluation event.
 * The database trigger is the backstop; this scan keeps the data access layer
 * from growing an update or delete path.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SERVER_ROOT = path.resolve(process.cwd(), 'src/server');

const FORBIDDEN = [
  /(?:\.|\b)update\(\s*workflowEvaluationEvents\b/,
  /(?:\.|\b)delete\(\s*workflowEvaluationEvents\b/,
  /UPDATE\s+workflow_evaluation_events\b/i,
  /DELETE\s+FROM\s+workflow_evaluation_events\b/i,
];

function serverSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...serverSourceFiles(fullPath));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('TBI-001 (d) / VT-07 — events have no update or delete path', () => {
  const files = serverSourceFiles(SERVER_ROOT);

  it('DoD NFR walks server source outside __tests__', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.includes(`${path.sep}db${path.sep}schema.ts`))).toBe(true);
  });

  it('no file calls update or delete on workflow evaluation events', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (FORBIDDEN.some((pattern) => pattern.test(source))) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
