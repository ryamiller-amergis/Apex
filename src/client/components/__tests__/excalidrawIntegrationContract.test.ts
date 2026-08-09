import { DIAGRAM_MAX_THUMBNAIL_BYTES } from '../../../shared/types/diagram';
import { DIAGRAM_MAX_THUMBNAIL_DIMENSION } from '../../utils/diagramThumbnail';

/**
 * VT-10 / TBI-005 DoD-0..2 — package pin + lazy route mount contracts.
 * Full Vite chunk inspection is covered at build time; these assertions lock
 * the FEAT-003 wiring that keeps Excalidraw out of the initial App entry.
 */
describe('FEAT-003 Excalidraw integration contracts (TBI-005 / VT-10)', () => {
  it('DoD-0: package.json pins @excalidraw/excalidraw to exact 0.18.1', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../../package.json') as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@excalidraw/excalidraw']).toBe('0.18.1');
  });

  it('DoD-2: App.tsx lazy-loads DiagramsView and DiagramEditorView', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appSource = fs.readFileSync(
      path.join(__dirname, '../../App.tsx'),
      'utf8',
    );
    expect(appSource).toMatch(/lazy\(\(\)\s*=>\s*[\s\S]*DiagramsView/);
    expect(appSource).toMatch(/lazy\(\(\)\s*=>\s*[\s\S]*DiagramEditorView/);
    expect(appSource).not.toMatch(/from ['"]\.\/components\/ExcalidrawAdapter['"]/);
  });

  it('DoD-1 / thumbnail contract: client bounds match shared 512 KB and 512 px', () => {
    expect(DIAGRAM_MAX_THUMBNAIL_BYTES).toBe(512 * 1024);
    expect(DIAGRAM_MAX_THUMBNAIL_DIMENSION).toBe(512);
  });
});
