/**
 * Evidence block parser unit tests (VT-01, VT-02, VT-03).
 * Owning items: TBI-020, TBI-021, PBI-022.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  EVIDENCE_TRUNCATION_MARKER,
  HEAD_EVIDENCE_BYTES,
  MAX_EVIDENCE_OUTPUT_BYTES,
  TAIL_EVIDENCE_BYTES,
  capEvidenceOutput,
  parseEvidenceBlock,
} from '../services/builds/evidenceBlockParser';
import {
  buildEvidenceBlobKey,
  buildEvidenceBlobPrefix,
  createBuildEvidenceStore,
  createInMemoryEvidenceStore,
} from '../services/builds/buildEvidenceStore';

function makeValidBlockJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    taskKey: 'T1',
    attemptNumber: 1,
    entries: [
      {
        requirementId: 'AC-3',
        tier: 'unit',
        testReferences: [{ file: 'src/server/__tests__/widget.test.ts', name: 'AC-3: rejects an empty title' }],
        red: {
          commit: 'a1b2c3d',
          command: 'npx jest src/server/__tests__/widget.test.ts',
          exitCode: 1,
          failedTests: ['AC-3: rejects an empty title'],
          output: 'FAIL src/server/__tests__/widget.test.ts',
        },
        green: {
          commit: 'd4e5f6a',
          command: 'npx jest src/server/__tests__/widget.test.ts',
          exitCode: 0,
          passedTests: ['AC-3: rejects an empty title'],
          output: 'PASS src/server/__tests__/widget.test.ts',
        },
        deferral: null,
      },
    ],
    checks: {
      typeCheck: { command: 'npx tsc --noEmit', exitCode: 0 },
      lint: { command: 'npx eslint src', exitCode: 0 },
      relatedTests: { command: 'npx jest --findRelatedTests src/widget.ts', exitCode: 0 },
    },
    standardsReview: { completed: true, findings: [] },
    escalation: null,
    ...overrides,
  };
}

describe('evidenceBlockParser', () => {
  describe('VT-01: valid apex-evidence block inside prose and last-block precedence', () => {
    it('VT-01: parses a valid apex-evidence block surrounded by prose and ignores the prose', () => {
      const payload = makeValidBlockJson();
      const message = [
        'I implemented the widget validation and ran the red and green test suites.',
        '',
        '```ts',
        'const unrelatedCodeFence = true;',
        '```',
        '',
        'Here is the verification evidence:',
        '```apex-evidence',
        JSON.stringify(payload, null, 2),
        '```',
        '',
        'All checks passed.',
      ].join('\n');

      const result = parseEvidenceBlock(message);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.block.version).toBe(1);
      expect(result.block.taskKey).toBe('T1');
      expect(result.block.attemptNumber).toBe(1);
      expect(result.block.entries).toHaveLength(1);
      expect(result.block.entries[0]).toEqual({
        requirementId: 'AC-3',
        tier: 'unit',
        testReferences: [{ file: 'src/server/__tests__/widget.test.ts', name: 'AC-3: rejects an empty title' }],
        red: {
          commit: 'a1b2c3d',
          command: 'npx jest src/server/__tests__/widget.test.ts',
          exitCode: 1,
          failedTests: ['AC-3: rejects an empty title'],
          output: 'FAIL src/server/__tests__/widget.test.ts',
        },
        green: {
          commit: 'd4e5f6a',
          command: 'npx jest src/server/__tests__/widget.test.ts',
          exitCode: 0,
          passedTests: ['AC-3: rejects an empty title'],
          output: 'PASS src/server/__tests__/widget.test.ts',
        },
        deferral: null,
      });
      expect(result.block.checks).toEqual({
        typeCheck: { command: 'npx tsc --noEmit', exitCode: 0 },
        lint: { command: 'npx eslint src', exitCode: 0 },
        relatedTests: { command: 'npx jest --findRelatedTests src/widget.ts', exitCode: 0 },
      });
      expect(result.block.standardsReview).toEqual({ completed: true, findings: [] });
      expect(result.block.escalation).toBeNull();
    });

    it('VT-01: takes the last apex-evidence block when two blocks appear in the message', () => {
      const firstBlock = makeValidBlockJson({ taskKey: 'T1-draft', attemptNumber: 1 });
      const secondBlock = makeValidBlockJson({ taskKey: 'T1-final', attemptNumber: 2 });
      const message = [
        'Draft block:',
        '```apex-evidence',
        JSON.stringify(firstBlock),
        '```',
        'Final block after fixing lint:',
        '```apex-evidence',
        JSON.stringify(secondBlock),
        '```',
      ].join('\n');

      const result = parseEvidenceBlock(message);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.block.taskKey).toBe('T1-final');
      expect(result.block.attemptNumber).toBe(2);
    });

    it('VT-01: parses incomplete entry fields (missing red/green/testReferences) and escalation blocks so the checker can inspect them', () => {
      const incompletePayload = makeValidBlockJson({
        entries: [
          {
            requirementId: 'AC-1',
            tier: 'unit',
            testReferences: [],
            red: null,
            green: null,
            deferral: null,
          },
          {
            requirementId: 'AC-2',
            tier: 'e2e',
            testReferences: [{ file: 'tests/e2e/specs/widget.spec.ts', name: 'AC-2: renders widget' }],
            deferral: { reason: 'Playwright browser unavailable in worker' },
          },
        ],
        checks: {
          typeCheck: null,
          lint: { command: 'npx eslint src', exitCode: 0 },
          relatedTests: null,
        },
        escalation: { reason: 'Needs migration', planPath: '.ai-pilot/plan.json' },
      });

      const message = `\`\`\`apex-evidence\n${JSON.stringify(incompletePayload)}\n\`\`\``;
      const result = parseEvidenceBlock(message);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.block.entries[0].red).toBeNull();
      expect(result.block.entries[0].green).toBeNull();
      expect(result.block.entries[0].testReferences).toEqual([]);
      expect(result.block.entries[1].deferral).toEqual({
        reason: 'Playwright browser unavailable in worker',
      });
      expect(result.block.checks.typeCheck).toBeNull();
      expect(result.block.escalation).toEqual({
        reason: 'Needs migration',
        planPath: '.ai-pilot/plan.json',
      });
    });
  });

  describe('VT-02: error codes for missing block, invalid JSON, unsupported version, and invalid shape', () => {
    it('VT-02: returns no_block when the message has no apex-evidence fence', () => {
      const message = 'I finished the task.\n```json\n{"version": 1}\n```';
      expect(parseEvidenceBlock(message)).toEqual({ ok: false, code: 'no_block' });
    });

    it('VT-02: returns invalid_json when the apex-evidence fence contains broken JSON', () => {
      const message = '```apex-evidence\n{"version": 1, "entries": [\n```';
      expect(parseEvidenceBlock(message)).toEqual({ ok: false, code: 'invalid_json' });
    });

    it('VT-02: returns unsupported_version when version is 2', () => {
      const payload = makeValidBlockJson({ version: 2 });
      const message = `\`\`\`apex-evidence\n${JSON.stringify(payload)}\n\`\`\``;
      expect(parseEvidenceBlock(message)).toEqual({ ok: false, code: 'unsupported_version' });
    });

    it('counts an unknown tier label such as component as unit instead of rejecting the block', () => {
      const base = makeValidBlockJson() as { entries: Array<Record<string, unknown>> };
      const payload = makeValidBlockJson({
        entries: [{ ...base.entries[0], tier: 'component' }],
      });
      const result = parseEvidenceBlock(`\`\`\`apex-evidence\n${JSON.stringify(payload)}\n\`\`\``);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.block.entries[0].tier).toBe('unit');
    });

    it('still rejects a tier that is not a string', () => {
      const base = makeValidBlockJson() as { entries: Array<Record<string, unknown>> };
      const payload = makeValidBlockJson({
        entries: [{ ...base.entries[0], tier: 7 }],
      });
      expect(
        parseEvidenceBlock(`\`\`\`apex-evidence\n${JSON.stringify(payload)}\n\`\`\``),
      ).toEqual({ ok: false, code: 'invalid_shape' });
    });

    it('VT-02: returns invalid_shape when entries is missing or top-level fields are malformed', () => {
      const withoutEntries = makeValidBlockJson();
      delete withoutEntries.entries;
      expect(
        parseEvidenceBlock(`\`\`\`apex-evidence\n${JSON.stringify(withoutEntries)}\n\`\`\``),
      ).toEqual({ ok: false, code: 'invalid_shape' });

      const nonArrayEntries = makeValidBlockJson({ entries: 'not-an-array' });
      expect(
        parseEvidenceBlock(`\`\`\`apex-evidence\n${JSON.stringify(nonArrayEntries)}\n\`\`\``),
      ).toEqual({ ok: false, code: 'invalid_shape' });

      const missingTaskKey = makeValidBlockJson({ taskKey: '' });
      expect(
        parseEvidenceBlock(`\`\`\`apex-evidence\n${JSON.stringify(missingTaskKey)}\n\`\`\``),
      ).toEqual({ ok: false, code: 'invalid_shape' });

      const badAttempt = makeValidBlockJson({ attemptNumber: 0 });
      expect(
        parseEvidenceBlock(`\`\`\`apex-evidence\n${JSON.stringify(badAttempt)}\n\`\`\``),
      ).toEqual({ ok: false, code: 'invalid_shape' });

      const entryMissingRequirementId = makeValidBlockJson({
        entries: [{ tier: 'unit' }],
      });
      expect(
        parseEvidenceBlock(`\`\`\`apex-evidence\n${JSON.stringify(entryMissingRequirementId)}\n\`\`\``),
      ).toEqual({ ok: false, code: 'invalid_shape' });
    });
  });

  describe('VT-03: 100 KB output cap keeps first 20 KB, last 80 KB, and truncation marker', () => {
    it('VT-03: caps a 300 KB output to the first 20 KB, a truncation marker, and the last 80 KB', () => {
      expect(MAX_EVIDENCE_OUTPUT_BYTES).toBe(100 * 1024);
      expect(HEAD_EVIDENCE_BYTES).toBe(20 * 1024);
      expect(TAIL_EVIDENCE_BYTES).toBe(80 * 1024);

      const headSegment = 'H'.repeat(HEAD_EVIDENCE_BYTES);
      const middleSegment = 'M'.repeat(200 * 1024);
      const tailSegment = 'T'.repeat(TAIL_EVIDENCE_BYTES);
      const raw300Kb = `${headSegment}${middleSegment}${tailSegment}`;
      expect(raw300Kb.length).toBe(300 * 1024);

      const payload = makeValidBlockJson({
        entries: [
          {
            requirementId: 'AC-3',
            tier: 'unit',
            testReferences: [{ file: 'src/server/__tests__/widget.test.ts', name: 'AC-3: test' }],
            red: {
              commit: 'a1b2c3d',
              command: 'npx jest',
              exitCode: 1,
              failedTests: ['AC-3: test'],
              output: raw300Kb,
            },
            green: {
              commit: 'd4e5f6a',
              command: 'npx jest',
              exitCode: 0,
              passedTests: ['AC-3: test'],
              output: raw300Kb,
            },
            deferral: null,
          },
        ],
      });

      const result = parseEvidenceBlock(`\`\`\`apex-evidence\n${JSON.stringify(payload)}\n\`\`\``);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      for (const capped of [result.block.entries[0].red?.output, result.block.entries[0].green?.output]) {
        expect(capped).toBeDefined();
        expect(capped!.startsWith(headSegment)).toBe(true);
        expect(capped!.endsWith(tailSegment)).toBe(true);
        expect(capped).toContain(EVIDENCE_TRUNCATION_MARKER);
        expect(capped).not.toContain('MMMM');
        expect(capped).toBe(`${headSegment}${EVIDENCE_TRUNCATION_MARKER}${tailSegment}`);
      }
    });

    it('VT-03: leaves outputs at or under 100 KB unchanged', () => {
      const exact100Kb = 'A'.repeat(MAX_EVIDENCE_OUTPUT_BYTES);
      expect(capEvidenceOutput(exact100Kb)).toBe(exact100Kb);
    });
  });

  describe('S5: buildEvidenceStore', () => {
    it('formats blob prefixes and slot keys and stores/streams evidence in memory and via container client', async () => {
      const prefix = buildEvidenceBlobPrefix('run-123', 2, 'AC-3');
      expect(prefix).toBe('builds/run-123/r2/AC-3');
      expect(buildEvidenceBlobKey(prefix, 'red')).toBe('builds/run-123/r2/AC-3/red.txt');
      expect(buildEvidenceBlobKey(`${prefix}/`, 'green')).toBe('builds/run-123/r2/AC-3/green.txt');

      const memoryStore = createInMemoryEvidenceStore('ai-run-artifacts');
      const ref = await memoryStore.putEvidence(prefix, 'red', 'FAIL output');
      expect(ref).toEqual({ container: 'ai-run-artifacts', key: 'builds/run-123/r2/AC-3' });
      expect(memoryStore.getText(ref, 'red')).toBe('FAIL output');

      const stream = await memoryStore.streamEvidence(ref, 'red');
      expect(stream).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('FAIL output');
      expect(await memoryStore.streamEvidence(ref, 'green')).toBeNull();

      const upload = jest.fn().mockResolvedValue({});
      const download = jest
        .fn()
        .mockResolvedValueOnce({ readableStreamBody: Readable.from(['PASS output']) })
        .mockRejectedValueOnce({ statusCode: 404, code: 'BlobNotFound' });
      const getBlockBlobClient = jest.fn(() => ({ upload, download }));
      const blobStore = createBuildEvidenceStore({
        getContainerClient: () => ({ getBlockBlobClient } as never),
        defaultContainer: () => 'ai-run-artifacts',
      });

      const uploadedRef = await blobStore.putEvidence(prefix, 'green', 'PASS output');
      expect(uploadedRef).toEqual({ container: 'ai-run-artifacts', key: 'builds/run-123/r2/AC-3' });
      expect(getBlockBlobClient).toHaveBeenCalledWith('builds/run-123/r2/AC-3/green.txt');
      expect(upload).toHaveBeenCalledWith(
        Buffer.from('PASS output', 'utf8'),
        Buffer.byteLength('PASS output', 'utf8'),
        { blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' } },
      );

      const downloadedStream = await blobStore.streamEvidence(uploadedRef, 'green');
      expect(downloadedStream).not.toBeNull();
      const missingStream = await blobStore.streamEvidence(uploadedRef, 'red');
      expect(missingStream).toBeNull();

      const source = fs.readFileSync(
        path.resolve(__dirname, '../services/builds/buildEvidenceStore.ts'),
        'utf8',
      );
      expect(source).not.toMatch(/drizzle|db\/schema/);
    });
  });
});
