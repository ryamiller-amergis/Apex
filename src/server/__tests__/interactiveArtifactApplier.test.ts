import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectInteractiveArtifacts } from '../services/interactiveActorHost/interactiveArtifactCollector';
import {
  InteractiveArtifactApplyError,
  applyInteractiveArtifacts,
} from '../services/interactiveArtifactApplier';
import type { AiRunV2ArtifactManifest } from '../../shared/types/aiRunV2';

describe('interactiveArtifactCollector', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'interactive-art-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('collects only approved .ai-pilot outputs', async () => {
    await fs.mkdir(path.join(root, '.ai-pilot', 'output'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.ai-pilot', 'kickoff-transcript.md'),
      'transcript',
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(root, '.ai-pilot', 'output', 'notes.md'),
      'notes',
      { mode: 0o600 },
    );
    await fs.writeFile(path.join(root, 'secret.txt'), 'nope', { mode: 0o600 });
    await fs.mkdir(path.join(root, '.ai-pilot', 'attachments'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(root, '.ai-pilot', 'attachments', 'x.txt'),
      'skip',
      { mode: 0o600 },
    );

    const collected = await collectInteractiveArtifacts(root);
    expect(collected.map((entry) => entry.relativePath)).toEqual([
      '.ai-pilot/kickoff-transcript.md',
      '.ai-pilot/output/notes.md',
    ]);
    expect(collected[0].sha256).toBe(
      createHash('sha256').update('transcript').digest('hex'),
    );
  });
});

describe('interactiveArtifactApplier', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'interactive-apply-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('verifies checksums and writes files beneath the thread workspace', async () => {
    const body = Buffer.from('hello output', 'utf8');
    const manifest: AiRunV2ArtifactManifest = {
      schemaVersion: 2,
      transport: 'servicebus-blob-v2',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      files: [
        {
          path: 'output/notes.md',
          sha256: createHash('sha256').update(body).digest('hex'),
          sizeBytes: body.byteLength,
          ref: { container: 'c', key: 'k' },
        },
      ],
      writtenAt: '2026-09-23T15:00:00.000Z',
    };

    await applyInteractiveArtifacts({
      workspaceRoot: root,
      manifest,
      expected: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
      },
      reader: {
        readFile: async () => body,
      },
    });

    expect(
      await fs.readFile(path.join(root, '.ai-pilot', 'output', 'notes.md'), 'utf8'),
    ).toBe('hello output');
  });

  it('rejects identity mismatch and path escape', async () => {
    const body = Buffer.from('x', 'utf8');
    await expect(
      applyInteractiveArtifacts({
        workspaceRoot: root,
        manifest: {
          schemaVersion: 2,
          transport: 'servicebus-blob-v2',
          runId: 'run-other',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          files: [],
          writtenAt: '2026-09-23T15:00:00.000Z',
        },
        expected: {
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
        },
        reader: { readFile: async () => body },
      }),
    ).rejects.toBeInstanceOf(InteractiveArtifactApplyError);

    await expect(
      applyInteractiveArtifacts({
        workspaceRoot: root,
        manifest: {
          schemaVersion: 2,
          transport: 'servicebus-blob-v2',
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          files: [
            {
              path: '../escape.txt',
              sha256: createHash('sha256').update(body).digest('hex'),
              sizeBytes: 1,
              ref: { container: 'c', key: 'k' },
            },
          ],
          writtenAt: '2026-09-23T15:00:00.000Z',
        },
        expected: {
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
        },
        reader: { readFile: async () => body },
      }),
    ).rejects.toBeInstanceOf(InteractiveArtifactApplyError);
  });
});
