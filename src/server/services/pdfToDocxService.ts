/**
 * PDF → DOCX conversion using pdfjs-dist for text extraction and JSZip for
 * DOCX packaging.  This avoids the LibreOffice WASM PDF-import path, which
 * produces empty HTML for most PDFs in the Node.js worker-thread context.
 *
 * Fidelity notes:
 *   - Text content is extracted and grouped into lines by y-coordinate.
 *   - Page order, line order, and basic paragraph breaks are preserved.
 *   - Complex layouts (multi-column, tables, wrapped text) are linearised.
 *   - Images, vector graphics, and fonts are not embedded in the output.
 */

import path from 'path';
import { pathToFileURL } from 'url';
import JSZip from 'jszip';

// ── pdfjs-dist lazy loader ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjsLib: any = null;

async function getPdfjsLib() {
  if (pdfjsLib) return pdfjsLib;
  // Use the legacy Node.js-compatible ESM build.  We must dynamic-import it
  // because it is ESM-only and our server bundle is CJS.
  pdfjsLib = await import(
    /* webpackIgnore: true */
    'pdfjs-dist/legacy/build/pdf.mjs' as string
  );
  const workerSrc = pathToFileURL(
    path.join(
      process.cwd(),
      'node_modules',
      'pdfjs-dist',
      'legacy',
      'build',
      'pdf.worker.mjs',
    ),
  ).href;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
  return pdfjsLib;
}

// ── Text extraction ───────────────────────────────────────────────────────────

interface TextLine {
  y: number;
  text: string;
}

/**
 * Extract text from every page of a PDF, returning one array of lines per page.
 */
async function extractPages(pdfBytes: Uint8Array): Promise<string[][]> {
  const lib = await getPdfjsLib();
  const loadingTask = lib.getDocument({
    data: pdfBytes,
    useSystemFonts: true,
    // Suppress console warnings about missing CMap files in Node context.
    cMapUrl: undefined,
    cMapPacked: true,
    verbosity: 0,
  });

  const pdf = await loadingTask.promise;
  const pages: string[][] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const tc = await page.getTextContent({ includeMarkedContent: false });

    // Group text items by rounded y-position (PDF coords go bottom-to-top).
    const lineMap = new Map<number, string[]>();
    for (const item of tc.items as Array<{ str: string; transform: number[] }>) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5]);
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y)!.push(item.str);
    }

    // Sort descending (highest y first = top of page first).
    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a);
    const lines = sortedYs.map((y) => lineMap.get(y)!.join('').trim()).filter(Boolean);
    pages.push(lines);
  }

  return pages;
}

// ── DOCX XML construction ─────────────────────────────────────────────────────

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .split('\u0000')
    .join(''); // strip null chars that break XML
}

function buildDocumentXml(pages: string[][]): string {
  const paras: string[] = [];

  for (let pi = 0; pi < pages.length; pi++) {
    const lines = pages[pi];
    if (lines.length === 0) {
      paras.push('<w:p/>');
    } else {
      for (const line of lines) {
        paras.push(
          `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`,
        );
      }
    }
    // Page break after every page except the last.
    if (pi < pages.length - 1) {
      paras.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document',
    '  xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
    '  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
    '  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    '  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    '  mc:Ignorable="w14 wp14">',
    '  <w:body>',
    ...paras.map((p) => `    ${p}`),
    '    <w:sectPr/>',
    '  </w:body>',
    '</w:document>',
  ].join('\n');
}

// ── DOCX package assembly ─────────────────────────────────────────────────────

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

/**
 * Convert a PDF buffer to a DOCX buffer by extracting text and building a
 * minimal Open XML package.
 */
export async function convertPdfToDocx(pdfBytes: Uint8Array | Buffer): Promise<Buffer> {
  const bytes = Buffer.isBuffer(pdfBytes) ? new Uint8Array(pdfBytes) : pdfBytes;
  const pages = await extractPages(bytes);
  const documentXml = buildDocumentXml(pages);

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', documentXml);
  zip.file('word/_rels/document.xml.rels', DOCUMENT_RELS);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
