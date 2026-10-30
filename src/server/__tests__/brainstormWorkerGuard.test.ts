import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isDurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';

/**
 * The worker holds no Brainstorm policy: App Service freezes every limit into
 * the specification, and a specification without them is refused before any
 * model call (`.cursor/rules/v2-worker-no-policy.mdc`).
 */
const WORKER_DIRS = [
  resolve(__dirname, '../services/aiRunsV2Worker'),
  resolve(__dirname, '../services/aiRunsWorker'),
];
const SHARED_TYPES = `${sep}shared${sep}types${sep}`;
const LIMIT_NAMES = /\b(workspaceMaxBytes|maxConcurrentClones|inactivityMs|creatorContext)\b/;

function workerGraph(): string[] {
  const queue = WORKER_DIRS.filter(existsSync).flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(dir, name)),
  );
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const pattern = /from '(\.[^']+)'/g;
    const source = readFileSync(file, 'utf8');
    let match = pattern.exec(source);
    while (match) {
      const candidate = resolve(dirname(file), `${match[1]}.ts`);
      if (existsSync(candidate)) queue.push(candidate);
      match = pattern.exec(source);
    }
  }
  return [...seen].sort();
}

describe('Brainstorm worker guard', () => {
  const graph = workerGraph();

  it('reaches the worker modules', () => {
    expect(graph.length).toBeGreaterThan(5);
  });

  it('defines no Brainstorm limit or creator default in worker code', () => {
    const offenders = graph
      .filter((file) => !file.includes(SHARED_TYPES))
      .filter((file) => LIMIT_NAMES.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('validates bootstrap specifications with the shared guard', () => {
    const callbackClient = readFileSync(resolve(__dirname, '../services/aiRunsWorker/callbackClient.ts'), 'utf8');
    expect(callbackClient).toMatch(/!isDurableInteractiveTurnSpecification\(body\.specification\)/);
  });

  it('refuses a Brainstorm specification whose limits are missing rather than filling them in', () => {
    const spec = {
      schemaVersion: 1,
      kind: 'interactive-turn',
      turnId: '10000000-0000-4000-8000-000000000001',
      threadId: '10000000-0000-4000-8000-000000000002',
      userId: 'user-1',
      projectId: 'project-1',
      interactiveClass: 'fast',
      workflowClass: 'brainstorm',
      model: 'model-a',
      effort: null,
      skill: null,
      currentMessage: { id: '10000000-0000-4000-8000-000000000001', text: 'Hi', hidden: false, attachments: [] },
      transcript: [],
      grounding: null,
      mcpServers: [],
      toolGrant: null,
      currentPrompt: 'Hi',
      recreationPrompt: 'Hi',
      deadlines: { absoluteTurnMs: 300_000, repositoryPreparationMs: null, firstEventMs: 30_000, toolCallMs: 60_000 },
      brainstorm: {
        sessionId: '10000000-0000-4000-8000-000000000003',
        creatorContext: { displayName: 'Ada', roles: [], groups: [], bio: null },
        sourceLimits: { workspaceMaxBytes: 1 },
        artifact: { type: null, version: 0, markdown: '' },
        intent: { kind: 'chat' },
      },
    };
    expect(isDurableInteractiveTurnSpecification(spec)).toBe(false);
  });
});
