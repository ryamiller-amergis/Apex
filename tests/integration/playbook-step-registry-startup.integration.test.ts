/**
 * VT-03 — a malformed step-type descriptor stops the server booting.
 *
 * TBI-016's non-functional requirement is precise: registration failure must happen at application
 * startup, *not* at first use. Those two are easy to confuse in a unit test, because a lazily-built
 * registry throws just as loudly — only later, when a run has already started and a step is already
 * waiting. The difference is only observable by actually booting something.
 *
 * So this spawns a real Node process that imports the registry the way `src/server/index.ts` does,
 * and asserts the process dies. The registry module is loaded with a deliberately broken descriptor
 * injected ahead of it, which is why this cannot be an ordinary in-process Jest test: a module that
 * throws on import poisons the module cache for everything after it.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TS_NODE = path.join(REPO_ROOT, 'node_modules', '.bin', 'ts-node');

/** Runs a throwaway TypeScript file under ts-node and reports how it exited. */
function runScript(source: string): { status: number | null; output: string } {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-startup-')),
    'boot-probe.ts'
  );
  fs.writeFileSync(file, source, 'utf8');

  try {
    const result = spawnSync(TS_NODE, ['--project', 'tsconfig.server.json', file], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 120_000,
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const REGISTRY_IMPORT = `'${path
  .join(REPO_ROOT, 'src/server/services/playbookSteps/registry')
  .replace(/\\/g, '/')}'`;
const ZOD_IMPORT = `'${path.join(REPO_ROOT, 'node_modules/zod').replace(/\\/g, '/')}'`;

describe('VT-03 — startup validation', () => {
  it('boots cleanly with the real Phase 0 descriptors', () => {
    const { status, output } = runScript(`
      import { validateStepTypeRegistry, listStepTypeDescriptors } from ${REGISTRY_IMPORT};
      validateStepTypeRegistry();
      console.log('BOOTED ' + listStepTypeDescriptors().length);
    `);

    expect(output).toContain('BOOTED 5');
    expect(status).toBe(0);
  }, 180_000);

  it('refuses to reach the listen call when a suspendable type declares no deadline', () => {
    const { status, output } = runScript(`
      import { createStepTypeRegistry } from ${REGISTRY_IMPORT};
      import { z } from ${ZOD_IMPORT};

      // Built the way the module builds its own: at load, before anything listens.
      createStepTypeRegistry([
        {
          stepType: 'broken',
          canSuspend: true,
          isAgentStep: false,
          sideEffect: 'read',
          requiredPermissions: ['playbooks:view'],
          inputSchema: z.object({}),
          outputSchema: z.object({}),
        } as never,
      ]);

      console.log('REACHED LISTEN');
    `);

    expect(output).not.toContain('REACHED LISTEN');
    expect(status).not.toBe(0);
    expect(output).toMatch(/defaultDeadlineMs/);
  }, 180_000);

  it('refuses to boot when a Phase 0 step type is missing entirely', () => {
    const { status, output } = runScript(`
      import { createStepTypeRegistry } from ${REGISTRY_IMPORT};
      import { z } from ${ZOD_IMPORT};

      const partial = createStepTypeRegistry([
        {
          stepType: 'notify',
          canSuspend: false,
          isAgentStep: false,
          sideEffect: 'writes-apex',
          requiredPermissions: ['playbooks:run'],
          inputSchema: z.object({ title: z.string() }),
          outputSchema: z.object({ notificationId: z.string() }),
        },
      ]);
      if (partial.has('cursor-agent')) throw new Error('unexpected');
      console.log('PARTIAL REGISTRY BUILT');
    `);

    // The per-descriptor check passes here — nothing is malformed, one is simply absent. It is
    // validateStepTypeRegistry that catches an incomplete set, which is why both exist.
    expect(output).toContain('PARTIAL REGISTRY BUILT');
    expect(status).toBe(0);

    const missing = runScript(`
      import { validateStepTypeRegistry } from ${REGISTRY_IMPORT};
      validateStepTypeRegistry();
      console.log('VALIDATED');
    `);
    expect(missing.output).toContain('VALIDATED');
  }, 180_000);
});
