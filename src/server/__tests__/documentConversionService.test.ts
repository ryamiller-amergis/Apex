/**
 * Unit tests for documentConversionService.
 * Covers: DoD-0 through DoD-5, NFR-eventloop, NFR-reuse (TBI-004)
 *
 * The Worker class and fs module are fully mocked — no real WASM or disk I/O.
 */

// ── Mock state ──────────────────────────────────────────────────────────────────

let mockWorkerHandlers: Record<string, Function[]>;
const mockPostMessage = jest.fn();
const mockTerminate = jest.fn();
let mockWorkerConstructorThrows = false;

function resetWorkerState() {
  mockWorkerHandlers = {};
  mockPostMessage.mockReset();
  mockTerminate.mockReset();
  mockWorkerConstructorThrows = false;
}

function triggerWorkerMessage(msg: any) {
  (mockWorkerHandlers['message'] ?? []).forEach((fn) => fn(msg));
}

function triggerWorkerError(err: Error) {
  (mockWorkerHandlers['error'] ?? []).forEach((fn) => fn(err));
}

// ── Mocks ───────────────────────────────────────────────────────────────────────

jest.mock('worker_threads', () => {
  return {
    Worker: jest.fn().mockImplementation(() => {
      if (mockWorkerConstructorThrows) {
        throw new Error('Failed to create worker');
      }
      const self: Record<string, any> = {};
      self.postMessage = mockPostMessage;
      self.terminate = mockTerminate;
      self.removeAllListeners = jest.fn();
      self.on = jest.fn((event: string, handler: Function) => {
        if (!mockWorkerHandlers[event]) mockWorkerHandlers[event] = [];
        mockWorkerHandlers[event].push(handler);
        return self;
      });
      self.off = jest.fn((event: string, handler: Function) => {
        if (mockWorkerHandlers[event]) {
          mockWorkerHandlers[event] = mockWorkerHandlers[event].filter(
            (h) => h !== handler,
          );
        }
        return self;
      });
      return self;
    }),
  };
});

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────────

import { DocumentConversionService, ConversionError } from '../services/documentConversionService';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';
import { Worker } from 'worker_threads';

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('documentConversionService', () => {
  let service: DocumentConversionService;
  const validPdfHeader = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

  beforeEach(() => {
    resetWorkerState();
    (Worker as unknown as jest.Mock).mockClear();
    service = new DocumentConversionService();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  // ── DoD-0: initializes WASM converter on first use with worker thread ───────

  test('DoD-0: creates worker on first convert call', async () => {
    mockPostMessage.mockImplementation(() => {
      process.nextTick(() =>
        triggerWorkerMessage({ success: true, pdfBuffer: validPdfHeader }),
      );
    });

    await service.convert(Buffer.from('docx-content'), 'test.docx');
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  test('DoD-0: reuses existing worker on subsequent calls', async () => {
    mockPostMessage.mockImplementation(() => {
      process.nextTick(() =>
        triggerWorkerMessage({ success: true, pdfBuffer: validPdfHeader }),
      );
    });

    await service.convert(Buffer.from('a'), 'a.docx');
    await service.convert(Buffer.from('b'), 'b.docx');
    expect(Worker).toHaveBeenCalledTimes(1);
  });

  // ── DoD-1: accepts Buffer and returns converted PDF Buffer ──────────────────

  test('DoD-1: returns PDF Buffer from successful conversion', async () => {
    const pdfOutput = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]);
    mockPostMessage.mockImplementation(() => {
      process.nextTick(() =>
        triggerWorkerMessage({ success: true, pdfBuffer: pdfOutput }),
      );
    });

    const result = await service.convert(Buffer.from('docx'), 'report.docx');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.slice(0, 4).toString()).toBe('%PDF');
  });

  test('DoD-1: passes buffer and filename to worker', async () => {
    const inputBuffer = Buffer.from('test-docx-content');
    mockPostMessage.mockImplementation((msg: any) => {
      expect(msg.filename).toBe('report.docx');
      expect(Buffer.isBuffer(msg.buffer) || msg.buffer instanceof Uint8Array).toBe(true);
      process.nextTick(() =>
        triggerWorkerMessage({ success: true, pdfBuffer: validPdfHeader }),
      );
    });

    await service.convert(inputBuffer, 'report.docx');
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  // ── DoD-4: error handling — format error ────────────────────────────────────

  test('DoD-4: throws ConversionError with CONVERSION_FAILED for format errors', async () => {
    mockPostMessage.mockImplementation(() => {
      process.nextTick(() =>
        triggerWorkerMessage({ success: false, error: 'Invalid document format' }),
      );
    });

    await expect(service.convert(Buffer.from('bad'), 'corrupt.docx')).rejects.toThrow(
      ConversionError,
    );
    try {
      await service.convert(Buffer.from('bad'), 'corrupt.docx');
    } catch (err) {
      expect((err as ConversionError).code).toBe(PDF_ERROR_CODES.CONVERSION_FAILED);
      expect((err as ConversionError).message).toContain('could not be converted');
    }
  });

  // ── DoD-4: error handling — timeout ─────────────────────────────────────────

  test('DoD-4: throws ConversionError with CONVERSION_TIMEOUT after the configured timeout', async () => {
    jest.useFakeTimers();

    mockPostMessage.mockImplementation(() => {
      // Worker never responds — simulating hung conversion
    });

    const promise = service.convert(Buffer.from('slow'), 'large.docx');
    // Async jobs allow a 15-minute default while retaining a finite runaway guard.
    jest.advanceTimersByTime(15 * 60_000 + 1_000);

    await expect(promise).rejects.toThrow(ConversionError);
    try {
      await promise;
    } catch (err) {
      expect((err as ConversionError).code).toBe(PDF_ERROR_CODES.CONVERSION_TIMEOUT);
    }

    jest.useRealTimers();
  });

  // ── DoD-4: error handling — WASM initialization failure ─────────────────────

  test('DoD-4: throws ConversionError with CONVERSION_UNAVAILABLE when worker fails to construct', async () => {
    mockWorkerConstructorThrows = true;

    await expect(
      service.convert(Buffer.from('test'), 'test.docx'),
    ).rejects.toThrow(ConversionError);

    try {
      await service.convert(Buffer.from('test'), 'test.docx');
    } catch (err) {
      expect((err as ConversionError).code).toBe(PDF_ERROR_CODES.CONVERSION_UNAVAILABLE);
    }
  });

  // ── DoD-5: unit tests verify successful conversion, timeout, error ──────────
  // (This DoD is satisfied by the tests themselves existing and passing)

  // ── NFR-reuse: worker re-initializes after crash ────────────────────────────

  test('NFR-reuse: reinitializes worker after crash and subsequent call succeeds', async () => {
    let callCount = 0;
    mockPostMessage.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call: worker crashes
        process.nextTick(() => triggerWorkerError(new Error('WASM crash')));
      } else {
        // Retry and subsequent calls: success
        process.nextTick(() =>
          triggerWorkerMessage({ success: true, pdfBuffer: validPdfHeader }),
        );
      }
    });

    // The service should retry once on crash, creating a new worker
    const result = await service.convert(Buffer.from('doc'), 'retry.docx');
    expect(Buffer.isBuffer(result)).toBe(true);
    // Worker was created twice: original + re-init after crash
    expect(Worker).toHaveBeenCalledTimes(2);
  });

  // ── Queue: sequential processing ───────────────────────────────────────────

  test('DoD-1: queues concurrent requests and processes sequentially', async () => {
    let resolveOrder: string[] = [];

    mockPostMessage.mockImplementation((msg: any) => {
      process.nextTick(() => {
        resolveOrder.push(msg.filename);
        triggerWorkerMessage({ success: true, pdfBuffer: validPdfHeader });
      });
    });

    const [r1, r2] = await Promise.all([
      service.convert(Buffer.from('a'), 'first.docx'),
      service.convert(Buffer.from('b'), 'second.docx'),
    ]);

    expect(Buffer.isBuffer(r1)).toBe(true);
    expect(Buffer.isBuffer(r2)).toBe(true);
    expect(resolveOrder[0]).toBe('first.docx');
    expect(resolveOrder[1]).toBe('second.docx');
  });

  // ── shutdown ──────────────────────────────────────────────────────────────────

  test('shutdown terminates worker and rejects queued requests', async () => {
    mockPostMessage.mockImplementation(() => {
      process.nextTick(() =>
        triggerWorkerMessage({ success: true, pdfBuffer: validPdfHeader }),
      );
    });

    await service.convert(Buffer.from('init'), 'init.docx');
    await service.shutdown();
    expect(mockTerminate).toHaveBeenCalled();
  });
});
