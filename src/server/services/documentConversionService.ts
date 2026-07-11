import { Worker } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

// ── Error types ─────────────────────────────────────────────────────────────────

export class ConversionError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
  }
}

// ── Constants ───────────────────────────────────────────────────────────────────

// Conversion runs outside the upload request, so large documents are not bound by
// Azure's HTTP timeout. Keep a generous finite ceiling to terminate hung WASM work.
const MIN_CONVERSION_TIMEOUT_MS = 60_000;
const MAX_CONVERSION_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CONVERSION_TIMEOUT_MS = 15 * 60_000;

function resolveConversionTimeoutMs(): number {
  const raw = process.env.DOCX_CONVERSION_TIMEOUT_MS;
  const parsed = raw != null && raw !== '' ? Number(raw) : DEFAULT_CONVERSION_TIMEOUT_MS;
  if (!Number.isFinite(parsed)) return DEFAULT_CONVERSION_TIMEOUT_MS;
  return Math.min(MAX_CONVERSION_TIMEOUT_MS, Math.max(MIN_CONVERSION_TIMEOUT_MS, parsed));
}

const CONVERSION_TIMEOUT_MS = resolveConversionTimeoutMs();

// ── Internal types ──────────────────────────────────────────────────────────────

interface QueuedRequest {
  buffer: Buffer;
  filename: string;
  resolve: (result: Buffer) => void;
  reject: (error: Error) => void;
}

interface WorkerResult {
  success: boolean;
  pdfBuffer?: Buffer;
  error?: string;
}

// ── Service ─────────────────────────────────────────────────────────────────────

export class DocumentConversionService {
  private worker: Worker | null = null;
  private busy = false;
  private queue: QueuedRequest[] = [];

  async convert(buffer: Buffer, originalFilename: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ buffer, filename: originalFilename, resolve, reject });
      this.processQueue();
    });
  }

  async shutdown(): Promise<void> {
    this.terminateWorker();
    for (const req of this.queue) {
      req.reject(
        new ConversionError(
          'Document conversion is temporarily unavailable. Please try again shortly.',
          PDF_ERROR_CODES.CONVERSION_UNAVAILABLE,
        ),
      );
    }
    this.queue = [];
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private processQueue(): void {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;

    const request = this.queue.shift()!;

    this.executeConversion(request.buffer, request.filename, false)
      .then((result) => request.resolve(result))
      .catch((err) => request.reject(err))
      .finally(() => {
        this.busy = false;
        this.processQueue();
      });
  }

  private async executeConversion(
    buffer: Buffer,
    filename: string,
    isRetry: boolean,
  ): Promise<Buffer> {
    const worker = this.ensureWorker();

    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        this.terminateWorker();
        reject(
          new ConversionError(
            'This Word document took too long to convert. Try saving it as PDF from Word directly.',
            PDF_ERROR_CODES.CONVERSION_TIMEOUT,
          ),
        );
      }, CONVERSION_TIMEOUT_MS);

      const onMessage = (msg: WorkerResult) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (msg.success && msg.pdfBuffer) {
          resolve(Buffer.from(msg.pdfBuffer));
        } else {
          reject(
            new ConversionError(
              'This Word document could not be converted. Try saving it as PDF from Word directly and uploading the PDF.',
              PDF_ERROR_CODES.CONVERSION_FAILED,
            ),
          );
        }
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.worker = null;

        if (!isRetry) {
          this.executeConversion(buffer, filename, true)
            .then(resolve)
            .catch(reject);
        } else {
          reject(
            new ConversionError(
              'Document conversion is temporarily unavailable. Please try again shortly.',
              PDF_ERROR_CODES.CONVERSION_UNAVAILABLE,
            ),
          );
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
      };

      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage({ buffer, filename });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const workerPath = this.resolveWorkerPath();
    try {
      this.worker = new Worker(workerPath);
      return this.worker;
    } catch {
      throw new ConversionError(
        'Document conversion is temporarily unavailable. Please try again shortly.',
        PDF_ERROR_CODES.CONVERSION_UNAVAILABLE,
      );
    }
  }

  private resolveWorkerPath(): string {
    const jsPath = path.join(__dirname, 'documentConversionWorker.js');
    if (fs.existsSync(jsPath)) return jsPath;
    return path.join(__dirname, 'documentConversionWorker.ts');
  }

  private terminateWorker(): void {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Worker may already be terminated
      }
      this.worker = null;
    }
  }
}

export const documentConversionService = new DocumentConversionService();
