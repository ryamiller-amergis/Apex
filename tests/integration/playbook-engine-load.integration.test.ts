/**
 * Wave A of design-docs/playbook-engine-integration.plan.md — the two integration triggers.
 *
 * The plan holds Wave B until these are answered, so the answers need to be re-runnable rather
 * than a paragraph somebody wrote once. Each check here asserts an observation, and the plan
 * records the verdict it produced.
 *
 * Trigger one (TBI-040, TBI-041) asks whether Mastra can resume a run that some other process, or
 * some other engine instance, started. Apex's own traversal passes this trivially because a
 * suspended run is only ever rows in `playbook_step_runs`; an engine holding run state in memory
 * would not, and that would end the integration.
 *
 * Trigger two (TBI-042) asks whether the engine can be loaded by the runner these suites use.
 *
 * Live checks run the engine through `support/engine-probe.ts` in a child process, for the reason
 * given at the top of playbook-engine-conformance.integration.test.ts and re-measured below: the
 * engine cannot be loaded under Jest's module runtime at all.
 */
import path from 'path';
import { execFileSync } from 'child_process';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PROBE = 'tests/integration/support/engine-probe.ts';

interface ColdSuspendResult {
  runId: string;
  startStatus: string;
}
interface ColdResumeResult {
  runId: string;
  foundInStorage: boolean;
  statusBefore: string | null;
  resumeStatus: string | null;
  resumeResult: unknown;
  resumeError: string | null;
  statusAfter: string | null;
}
interface CrossInstanceResult {
  runId: string;
  startStatus: string;
  visibleToOtherInstance: boolean;
  resumeStatus: string | null;
  resumeResult: unknown;
  resumeError: string | null;
  statusSeenByStarterAfter: string | null;
}

describe('Playbook engine integration triggers — trigger one: resumption', () => {
  let scratch: ScratchDatabase;
  let suspend: ColdSuspendResult;
  let resume: ColdResumeResult;
  let cross: CrossInstanceResult;

  /** Runs one probe mode under ts-node and returns its JSON result. */
  function probe<T>(mode: string, schema: string, extra?: string): T {
    const args = ['ts-node', '-P', 'tsconfig.e2e.json', '--transpile-only', PROBE, mode, scratch.connectionString, schema];
    if (extra) args.push(extra);

    let stdout: string;
    try {
      stdout = execFileSync('npx', args, {
        encoding: 'utf8',
        shell: true,
        maxBuffer: 32 * 1024 * 1024,
        cwd: REPO_ROOT,
      });
    } catch (error) {
      const detail = error as { stderr?: string; message?: string };
      throw new Error(
        `Cannot evaluate trigger one: the engine probe failed in mode "${mode}".\n` +
          `  A probe that will not run leaves the question unanswered, which is a failure here.\n` +
          `  ${String(detail.stderr ?? detail.message).slice(0, 600)}`
      );
    }
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PROBE_RESULT '));
    if (!line) throw new Error(`Engine probe "${mode}" produced no result line. Output tail: ${stdout.slice(-400)}`);
    return JSON.parse(line.slice('PROBE_RESULT '.length));
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('triggers');

    /*
     * Two child processes, not one. The whole question is whether the `Run` object that suspended
     * the run is required to resume it, and only a process boundary actually destroys that object.
     * Resuming from a second object in the same process would pass while proving nothing.
     */
    suspend = probe<ColdSuspendResult>('cold-suspend', 'wave_a_cold');
    resume = probe<ColdResumeResult>('cold-resume', 'wave_a_cold', suspend.runId);

    cross = probe<CrossInstanceResult>('cross-instance', 'wave_a_cross');
  }, 600_000);

  afterAll(async () => {
    if (scratch) await scratch.drop();
  });

  // TBI-040
  it('TBI-040: suspends a run in one process and resumes it from a process that never saw it start', () => {
    expect(suspend.startStatus).toBe('suspended');

    // Separates "the snapshot survived" from "resume works". A null here would mean the run never
    // persisted, and resumption was never the thing that failed.
    expect(resume.foundInStorage).toBe(true);
    expect(resume.statusBefore).toBe('suspended');

    expect(resume.resumeError).toBeNull();
    expect(resume.resumeStatus).toBe('success');
    expect(resume.resumeResult).toEqual({ decision: 'approved' });
    expect(resume.statusAfter).toBe('success');
  });

  // TBI-041
  it('TBI-041: resumes on an engine instance that did not start the run, over a shared store', () => {
    expect(cross.startStatus).toBe('suspended');

    // The second instance created none of the tables and observed none of the start.
    expect(cross.visibleToOtherInstance).toBe(true);
    expect(cross.resumeError).toBeNull();
    expect(cross.resumeStatus).toBe('success');
    expect(cross.resumeResult).toEqual({ decision: 'approved' });

    /*
     * Asked of the instance that started the run, because a stale starter is the failure that would
     * not announce itself: instance B finishes the run while instance A still believes it suspended,
     * and Apex's status view shows whichever instance the request happened to land on.
     */
    expect(cross.statusSeenByStarterAfter).toBe('success');
  });
});

describe('Playbook engine integration triggers — trigger two: loading under the runner', () => {
  /*
   * This check asserts that loading FAILS, which is worth being explicit about.
   *
   * The finding is the reason every live engine check in this repo pays for a child process. If a
   * future version of Mastra, or of its dependencies, ships a CommonJS build, this check goes red —
   * and that redness is the signal to delete the out-of-process machinery rather than keep paying
   * for it out of habit. A check that only asserted the workaround works would never say so.
   */
  it('TBI-042: cannot load the engine under Jest, by any strategy, because a dependency is ESM-only', async () => {
    const attempts: { strategy: string; error: string | null }[] = [];

    const attempt = (strategy: string, load: () => unknown) => {
      try {
        load();
        attempts.push({ strategy, error: null });
      } catch (error) {
        attempts.push({ strategy, error: error instanceof Error ? error.message : String(error) });
      }
    };

    attempt("require('@mastra/core/workflows')", () => require('@mastra/core/workflows'));
    attempt("require('@mastra/core')", () => require('@mastra/core'));
    attempt("require('@mastra/pg')", () => require('@mastra/pg'));

    try {
      await import('@mastra/pg');
      attempts.push({ strategy: "await import('@mastra/pg')", error: null });
    } catch (error) {
      attempts.push({
        strategy: "await import('@mastra/pg')",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const loaded = attempts.filter((a) => a.error === null).map((a) => a.strategy);
    expect({ loaded, note: 'see the comment above — a strategy that now works is good news' }).toEqual({
      loaded: [],
      note: 'see the comment above — a strategy that now works is good news',
    });

    // Every failure is the same module-system mismatch, not four unrelated problems.
    attempts.forEach((a) => {
      expect(a.error).toMatch(/Cannot use import statement outside a module|Must use import to load ES Module/);
    });
  });

  it('TBI-042: keeps the out-of-process escape hatch available, which is what makes the failure survivable', () => {
    // The probe is the workaround. If it stops existing, the live checks in this file and in the
    // conformance suite have no way to reach the engine at all.
    const probePath = path.join(REPO_ROOT, PROBE);
    expect(require('fs').existsSync(probePath)).toBe(true);
  });
});
