import {
  createPlaybookStepOutputStore,
  PlaybookStepOutputVerificationError,
  resolvePlaybookStepOutputAccount,
  type PlaybookStepOutputBackend,
} from '../services/playbookStepOutputStore';

function memoryBackend(): PlaybookStepOutputBackend & { bodies: Map<string, Buffer> } {
  const bodies = new Map<string, Buffer>();
  return {
    bodies,
    async write(key, body) {
      bodies.set(key, Buffer.from(body));
    },
    async read(key) {
      const body = bodies.get(key);
      if (!body) throw new Error('missing');
      return Buffer.from(body);
    },
    async delete(key) {
      bodies.delete(key);
    },
    async list() {
      return [...bodies.keys()].map((key) => ({ key, lastModifiedMs: 1 }));
    },
  };
}

const metadata = {
  project: 'Apex',
  runId: 'run-1',
  stepRunId: 'step-run-1',
  stepId: 'draft',
  stepType: 'cursor-agent',
  completedAt: '2026-10-19T00:00:00.000Z',
};

describe('Playbook step output store', () => {
  it('uses the shared Blob account already configured for Apex', () => {
    expect(resolvePlaybookStepOutputAccount({
      PLAYBOOK_STEP_OUTPUT_BLOB_ACCOUNT_NAME: 'explicit',
      PDF_BLOB_ACCOUNT_NAME: 'shared',
    })).toBe('explicit');
    expect(resolvePlaybookStepOutputAccount({
      PDF_BLOB_ACCOUNT_NAME: ' stapexdevasync ',
    })).toBe('stapexdevasync');
  });

  it('keeps a small output inline', async () => {
    const backend = memoryBackend();
    const store = createPlaybookStepOutputStore({ backend, thresholdBytes: 100 });
    const stored = await store.persist({
      ...metadata,
      enabled: true,
      output: { verdict: 'ready' },
    });

    expect(stored).toEqual({
      outputInline: { verdict: 'ready' },
      outputBlobRef: null,
    });
    expect(backend.bodies.size).toBe(0);
  });

  it('spills a large output and verifies it on read', async () => {
    const backend = memoryBackend();
    const store = createPlaybookStepOutputStore({ backend, thresholdBytes: 10 });
    const output = { verdict: 'ready', reportMd: 'long report body' };
    const stored = await store.persist({ ...metadata, enabled: true, output });

    expect(stored.outputBlobRef?.key).toMatch(
      /^Apex\/run-1\/step-run-1\/output-v1-[a-f0-9]{64}\.json$/
    );
    expect(stored.outputInline).toMatchObject({
      spilled: true,
      verdict: 'ready',
    });
    expect((await store.load(stored.outputBlobRef!)).output).toEqual(output);
  });

  it('refuses a changed blob', async () => {
    const backend = memoryBackend();
    const store = createPlaybookStepOutputStore({ backend, thresholdBytes: 1 });
    const stored = await store.persist({
      ...metadata,
      enabled: true,
      output: { reportMd: 'report' },
    });
    backend.bodies.set(stored.outputBlobRef!.key, Buffer.from('{}'));

    await expect(store.load(stored.outputBlobRef!)).rejects.toThrow(
      PlaybookStepOutputVerificationError
    );
  });

  it('keeps output inline while the rollout flag is disabled', async () => {
    const backend = memoryBackend();
    const store = createPlaybookStepOutputStore({ backend, thresholdBytes: 1 });
    const output = { reportMd: 'report' };

    await expect(
      store.persist({ ...metadata, enabled: false, output })
    ).resolves.toEqual({ outputInline: output, outputBlobRef: null });
  });

  it('uses content-addressed keys so a losing duplicate cannot delete the winner', async () => {
    const backend = memoryBackend();
    const store = createPlaybookStepOutputStore({ backend, thresholdBytes: 1 });
    const output = { reportMd: 'report' };
    const first = await store.persist({
      ...metadata,
      completedAt: '2026-10-19T00:00:00.000Z',
      enabled: true,
      output,
    });
    const duplicate = await store.persist({
      ...metadata,
      completedAt: '2026-10-19T00:00:01.000Z',
      enabled: true,
      output,
    });

    expect(first.outputBlobRef?.key).not.toBe(duplicate.outputBlobRef?.key);
    await store.delete(duplicate.outputBlobRef!);
    await expect(store.load(first.outputBlobRef!)).resolves.toMatchObject({ output });
  });
});
