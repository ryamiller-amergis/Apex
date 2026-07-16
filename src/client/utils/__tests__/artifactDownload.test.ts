import {
  createArtifactZip,
  downloadArtifactZip,
  sanitizeArtifactName,
} from '../artifactDownload';

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('artifactDownload', () => {
  it('creates a ZIP containing each named text artifact', async () => {
    const blob = createArtifactZip(
      [
        { name: 'prd.md', content: '# Product' },
        { name: 'backlog.json', content: '{\n  "epics": []\n}' },
      ],
      new Date(2026, 6, 15, 12, 0, 0),
    );
    const bytes = new Uint8Array(await readBlob(blob));
    const view = new DataView(bytes.buffer);
    const decoder = new TextDecoder();
    const entries: Record<string, string> = {};
    let offset = 0;

    while (view.getUint32(offset, true) === 0x04034b50) {
      const contentLength = view.getUint32(offset + 18, true);
      const nameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      const nameStart = offset + 30;
      const contentStart = nameStart + nameLength + extraLength;
      const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
      entries[name] = decoder.decode(bytes.slice(contentStart, contentStart + contentLength));
      offset = contentStart + contentLength;
    }

    expect(blob.type).toBe('application/zip');
    expect(entries).toEqual({
      'prd.md': '# Product',
      'backlog.json': '{\n  "epics": []\n}',
    });
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
  });

  it('sanitizes titles for Windows-safe export names', () => {
    expect(sanitizeArtifactName('  Payments: Design / V2?  ', 'artifact')).toBe(
      'Payments-Design-V2',
    );
    expect(sanitizeArtifactName('...', 'artifact')).toBe('artifact');
  });

  it('starts one browser download and releases the object URL', () => {
    jest.useFakeTimers();
    const createObjectURL = jest.fn().mockReturnValue('blob:artifact');
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    downloadArtifactZip('example.zip', [{ name: 'design.md', content: '# Design' }]);

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    jest.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:artifact');

    click.mockRestore();
    delete (URL as Partial<typeof URL>).createObjectURL;
    delete (URL as Partial<typeof URL>).revokeObjectURL;
    jest.useRealTimers();
  });
});
