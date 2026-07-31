import { parentPort } from 'worker_threads';
import path from 'path';

export type ConversionOutputFormat = 'pdf' | 'docx';

export interface ConversionMessage {
  buffer: Buffer;
  filename: string;
  outputFormat?: ConversionOutputFormat;
}

export interface ConversionResult {
  success: boolean;
  outputBuffer?: Buffer;
  error?: string;
}

type ConvertDocument = typeof import('@matbee/libreoffice-converter')['convertDocument'];

let convertDocument: ConvertDocument | null = null;
const converterWasmPath = path.join(
  process.cwd(),
  'node_modules',
  '@matbee',
  'libreoffice-converter',
  'wasm',
);

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
    const outputFormat: ConversionOutputFormat = msg.outputFormat ?? 'pdf';
    const output = await convertDocument!(
      Buffer.from(msg.buffer),
      { outputFormat },
      { wasmPath: converterWasmPath },
    );
    result.success = true;
    result.outputBuffer = Buffer.from(output.data);
  } catch (err) {
    result.error = err instanceof Error ? err.message : 'Unknown conversion error';
  }
  parentPort?.postMessage(result);
});
