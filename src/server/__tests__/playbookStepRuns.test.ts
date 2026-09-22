/**
 * FEAT-008 Wave 2 Bundle C S6 — `failStepRunForHuman`, the atomic park-for-a-human transition.
 *
 * TBI-035 needs an execution-time refusal that "fails the step and suspends the run for a human,
 * using the existing failure path". The prerequisite this file owns is the state move itself, and
 * the part worth testing is that the two halves cannot come apart: a step parked at
 * `failed_retryable` whose run still reads `running` is a run the engine will keep advancing, and a
 * run suspended with no parked step is a run nobody can explain. VT-17 and VT-18 both read run and
 * step state back after the fact, so a window in which only one half had been written is a window
 * in which either of them can observe a lie.
 *
 * Asserted through a hand-rolled Drizzle double, in the style of `playbookRunService.test.ts`: what
 * matters here is which handle each write used and what each update was guarded on, neither of
 * which a real database would show more clearly than the recorded statements do.
 */
type RecordedWrite = {
  table: string;
  set: Record<string, unknown>;
  where: unknown;
  /** `tx` when the write went through the transaction callback's handle, `db` when it bypassed it. */
  handle: 'db' | 'tx';
};

const writes: RecordedWrite[] = [];
const inserts: string[] = [];
const stepUpdateResult = jest.fn<Promise<{ id: string; runId: string }[]>, []>();
const runUpdateResult = jest.fn<Promise<{ id: string }[]>, []>();
const transactionCalls = jest.fn();
let rolledBack = false;

jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

jest.mock('../db/drizzle', () => {
  /* eslint-disable @typescript-eslint/no-require-imports -- the double needs Drizzle's own helpers */
  const { getTableName } = require('drizzle-orm') as typeof import('drizzle-orm');
  /* eslint-enable @typescript-eslint/no-require-imports */

  /** Awaitable on its own and also `.returning()`-able, because both call styles are in use. */
  const chain = (rows: Promise<unknown[]>) => {
    const thenable = rows as Promise<unknown[]> & { returning: () => Promise<unknown[]> };
    thenable.returning = () => rows;
    return thenable;
  };

  const update = (handle: 'db' | 'tx') => (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (condition: unknown) => {
        const name = getTableName(table as Parameters<typeof getTableName>[0]);
        writes.push({ table: name, set: values, where: condition, handle });
        return chain(
          name === 'playbook_step_runs'
            ? (stepUpdateResult() as Promise<unknown[]>)
            : (runUpdateResult() as Promise<unknown[]>)
        );
      },
    }),
  });

  const insert = (table: unknown) => {
    inserts.push(getTableName(table as Parameters<typeof getTableName>[0]));
    return { values: () => ({ returning: async () => [{ id: 'inserted' }] }) };
  };

  const tx = { update: update('tx'), insert };

  return {
    db: {
      update: update('db'),
      insert,
      transaction: async (callback: (handle: typeof tx) => Promise<unknown>) => {
        transactionCalls();
        try {
          return await callback(tx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    },
  };
});

import { failStepRun, failStepRunForHuman } from '../services/playbookSteps/stepRuns';
import {
  PLAYBOOK_RUN_STATUSES,
  PLAYBOOK_STEP_RUN_OPEN_STATUSES,
  type PlaybookRunStatus,
} from '../../shared/types/playbook';

const STEP_RUN_ID = 'step-run-1';
const RUN_ID = 'run-1';
const REASON = 'notify is now leaves-apex and this step has no gate in front of it';

/** Run states from which a parked step must not revive the run. */
const TERMINAL_RUN_STATUSES: PlaybookRunStatus[] = PLAYBOOK_RUN_STATUSES.filter(
  (status) => status !== 'running' && status !== 'suspended'
);

/**
 * Flattens a Drizzle condition into the column names and bound values it mentions, so a test can
 * assert what the database was asked rather than only what the double was told to answer. An
 * unguarded update would pass every behavioural assertion in this file without this.
 */
const sqlTerms = (node: unknown): string[] => {
  if (node === null || node === undefined) return [];
  if (Array.isArray(node)) return node.flatMap(sqlTerms);
  if (typeof node !== 'object') return [String(node)];
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) return sqlTerms(record.queryChunks);
  if (typeof record.name === 'string') return [record.name];
  if ('value' in record) return sqlTerms(record.value);
  return [];
};

const writesTo = (table: string): RecordedWrite[] => writes.filter((w) => w.table === table);
const stepWrite = (): RecordedWrite => writesTo('playbook_step_runs')[0];
const runWrite = (): RecordedWrite | undefined => writesTo('playbook_runs')[0];

beforeEach(() => {
  jest.clearAllMocks();
  writes.length = 0;
  inserts.length = 0;
  rolledBack = false;
  stepUpdateResult.mockResolvedValue([{ id: STEP_RUN_ID, runId: RUN_ID }]);
  runUpdateResult.mockResolvedValue([{ id: RUN_ID }]);
});

describe('S6 — failStepRunForHuman parks the step and suspends its run', () => {
  it('moves the step to failed_retryable with the specific reason and completion timestamps', async () => {
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON });

    expect(stepWrite().set).toEqual(
      expect.objectContaining({
        status: 'failed_retryable',
        outputInline: { error: REASON },
      })
    );
    // Both, because the status view orders by one and the sweep reads the other.
    expect(Date.parse(String(stepWrite().set.completedAt))).not.toBeNaN();
    expect(Date.parse(String(stepWrite().set.updatedAt))).not.toBeNaN();
  });

  it('stores the reason it was given rather than a generic failure', async () => {
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: 'ungated leaves-apex step' });

    expect(stepWrite().set.outputInline).toEqual({ error: 'ungated leaves-apex step' });
  });

  it('suspends the run that owns the step, found from the step itself', async () => {
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON });

    expect(runWrite()?.set).toEqual(expect.objectContaining({ status: 'suspended' }));
    expect(sqlTerms(runWrite()?.where)).toContain(RUN_ID);
  });

  it('reports that it moved the step', async () => {
    await expect(failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON })).resolves.toBe(
      true
    );
  });

  it('guards the step move on the open statuses, so a terminal step is never rewritten', async () => {
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON });

    const terms = sqlTerms(stepWrite().where);
    expect(terms).toEqual(expect.arrayContaining([...PLAYBOOK_STEP_RUN_OPEN_STATUSES]));
    expect(terms).toContain(STEP_RUN_ID);
    for (const terminal of ['completed', 'failed', 'failed_retryable', 'cancelled', 'expired']) {
      expect(terms).not.toContain(terminal);
    }
  });

  it('guards the run move on the nonterminal statuses, so a finished run is never revived', async () => {
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON });

    const terms = sqlTerms(runWrite()?.where);
    expect(terms).toContain('running');
    // A cancelled or expired run suspended again is a run the sweep has already ended.
    for (const terminal of TERMINAL_RUN_STATUSES) {
      expect(terms).not.toContain(terminal);
    }
  });
});

describe('S6 — the two moves are one transaction', () => {
  it('writes both through the transaction handle and neither around it', async () => {
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON });

    expect(transactionCalls).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(2);
    expect(writes.map((w) => w.handle)).toEqual(['tx', 'tx']);
  });

  it('parks the step before suspending the run, so the run never suspends with nothing to show', async () => {
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON });

    expect(writes.map((w) => w.table)).toEqual(['playbook_step_runs', 'playbook_runs']);
  });

  it('rolls the step move back when suspending the run fails', async () => {
    runUpdateResult.mockRejectedValue(new Error('run update lost the connection'));

    await expect(failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON })).rejects.toThrow(
      /connection/
    );

    // The step write happened inside the transaction that threw, so it is undone with it.
    expect(rolledBack).toBe(true);
    expect(stepWrite().handle).toBe('tx');
  });
});

describe('S6 — nothing to park', () => {
  it('returns false for a step that is absent or already terminal', async () => {
    stepUpdateResult.mockResolvedValue([]);

    await expect(failStepRunForHuman({ stepRunId: 'gone', reason: REASON })).resolves.toBe(false);
  });

  it('leaves the run untouched', async () => {
    stepUpdateResult.mockResolvedValue([]);

    await failStepRunForHuman({ stepRunId: 'gone', reason: REASON });

    expect(writesTo('playbook_runs')).toHaveLength(0);
  });

  it('never retries the step, on either path', async () => {
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON });
    stepUpdateResult.mockResolvedValue([]);
    await failStepRunForHuman({ stepRunId: STEP_RUN_ID, reason: REASON });

    // No second step-run row, and no step moved back to an open status to be picked up again.
    expect(inserts).toHaveLength(0);
    for (const write of writesTo('playbook_step_runs')) {
      expect(PLAYBOOK_STEP_RUN_OPEN_STATUSES).not.toContain(write.set.status);
    }
  });
});

describe('failStepRun is unchanged', () => {
  it('still marks a step failed outside any transaction, touching no run', async () => {
    await failStepRun({ stepRunId: STEP_RUN_ID, reason: REASON });

    expect(transactionCalls).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(stepWrite().handle).toBe('db');
    expect(stepWrite().set).toEqual(
      expect.objectContaining({ status: 'failed', outputInline: { error: REASON } })
    );
  });

  it('still writes failed_retryable when asked, and still suspends nothing', async () => {
    await failStepRun({ stepRunId: STEP_RUN_ID, retryable: true, reason: REASON });

    expect(stepWrite().set).toEqual(expect.objectContaining({ status: 'failed_retryable' }));
    expect(writesTo('playbook_runs')).toHaveLength(0);
  });

  it('still omits the output when no reason is given', async () => {
    await failStepRun({ stepRunId: STEP_RUN_ID });

    expect(stepWrite().set).not.toHaveProperty('outputInline');
  });
});
