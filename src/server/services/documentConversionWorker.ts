import { parentPort } from 'worker_threads';

interface ConversionMessage {
  buffer: Buffer;
  filename: string;
}

interface ConversionResult {
  success: boolean;
  pdfBuffer?: Buffer;
  error?: string;
}

let convertDocument: ((buf: Buffer, opts: { outputFormat: string }) => Promise<{ data: Buffer }>) | null = null;

async function ensureConverter() {
  if (!convertDocument) {
    const mod = await import('@matbee/libreoffice-converter');
    convertDocument = mod.convertDocument;
  }
}

parentPort?.on('message', async (msg: ConversionMessage) => {
  const result: ConversionResult = { success: false };
  try {
    await ensureConverter();
    const output = await convertDocument!(Buffer.from(msg.buffer), { outputFormat: 'pdf' });
    result.success = true;
    result.pdfBuffer = Buffer.from(output.data);
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'Unknown conversion error';
  }
  parentPort?.postMessage(result);
});
