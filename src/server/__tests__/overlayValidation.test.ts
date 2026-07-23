import type {
  OverlayFontFamily,
  OverlayTextBox,
  PageManifestEntry,
} from '../../shared/types/pdf';
import {
  stripOrphanOverlays,
  validateOverlays,
} from '../services/overlayValidation';

const PAGE_IDS = new Set(['page-1']);

function makeOverlay(
  overrides: Partial<OverlayTextBox> = {},
  index = 0
): OverlayTextBox {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    pageId: 'page-1',
    x: 10,
    y: 15,
    width: 30,
    height: 10,
    text: 'Overlay text',
    fontFamily: 'Helvetica',
    fontSize: 14,
    bold: false,
    italic: false,
    color: '#123ABC',
    horizontalAlign: 'left',
    verticalAlign: 'top',
    opacity: 100,
    rotation: 0,
    listStyle: 'none',
    linkUrl: null,
    linkDisplayText: null,
    zIndex: 0,
    ...overrides,
  };
}

function errorFields(result: ReturnType<typeof validateOverlays>): string[] {
  return result.ok === true ? [] : result.errors.map((error) => error.field);
}

describe('stripOrphanOverlays', () => {
  const page = (
    pageId: string,
    deleted = false,
    rotation: PageManifestEntry['rotation'] = 0
  ): PageManifestEntry => ({
    pageId,
    fileId: 'file-1',
    sourcePageIndex: 0,
    rotation,
    deleted,
  });

  it('drops only overlays for absent or soft-deleted pages', () => {
    const overlays = [
      makeOverlay({ pageId: 'page-1' }, 1),
      makeOverlay({ pageId: 'page-2' }, 2),
      makeOverlay({ pageId: 'page-3' }, 3),
    ];

    expect(
      stripOrphanOverlays(
        [page('page-1'), page('page-2', true), page('page-3')],
        overlays
      )
    ).toEqual([overlays[0], overlays[2]]);
  });

  it('preserves bindings and percentage geometry across reorder and rotation', () => {
    const overlays = [
      makeOverlay({ pageId: 'page-1', x: 12, y: 34 }, 1),
      makeOverlay({ pageId: 'page-2', x: 56, y: 78 }, 2),
    ];

    expect(
      stripOrphanOverlays(
        [page('page-2', false, 90), page('page-1', false, 270)],
        overlays
      )
    ).toEqual(overlays);
  });
});

describe('validateOverlays', () => {
  it('accepts collision-safe replacement metadata', () => {
    const overlay = {
      ...makeOverlay({
        kind: 'replace',
        backgroundColor: '#FFFFFF',
      }),
      replacementCover: { x: 80, y: 10, width: 10, height: 3 },
      replacementBounds: { xMin: 60, xMax: 100, yMax: 25 },
      replacementOverflow: false,
    };

    const result = validateOverlays([overlay], PAGE_IDS);

    expect(result).toEqual({ ok: true, overlays: [overlay] });
  });

  it('rejects malformed collision-safe replacement metadata', () => {
    const result = validateOverlays(
      [
        {
          ...makeOverlay({
            kind: 'replace',
            backgroundColor: '#FFFFFF',
          }),
          replacementCover: { x: 80, y: 10, width: -1, height: 3 },
          replacementBounds: { xMin: 70, xMax: 60, yMax: 101 },
          replacementOverflow: 'yes',
        },
      ],
      PAGE_IDS
    );

    expect(errorFields(result)).toEqual(
      expect.arrayContaining([
        'replacementCover',
        'replacementBounds',
        'replacementOverflow',
      ])
    );
  });

  it('VT-09: accepts all inclusive numeric and content boundaries', () => {
    const result = validateOverlays(
      [
        makeOverlay({
          text: 'x'.repeat(2_000),
          fontSize: 8,
          opacity: 10,
          rotation: -180,
          width: 5,
          height: 3,
          linkUrl: 'https://example.com/path',
        }),
        makeOverlay(
          {
            fontFamily: 'Courier',
            fontSize: 72,
            opacity: 100,
            rotation: 180,
            color: '#ffffff',
          },
          1
        ),
      ],
      PAGE_IDS
    );

    expect(result.ok).toBe(true);
  });

  it('VT-09: accepts 50 overlays and rejects 51 with a session-level error', () => {
    const fifty = Array.from({ length: 50 }, (_, index) =>
      makeOverlay({}, index)
    );
    expect(validateOverlays(fifty, PAGE_IDS).ok).toBe(true);

    const result = validateOverlays([...fifty, makeOverlay({}, 50)], PAGE_IDS);
    expect(result).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          overlayId: null,
          field: 'overlays',
          code: 'OVERLAY_COUNT_EXCEEDED',
        }),
      ],
    });
  });

  it.each([
    ['text', { text: 'x'.repeat(2_001) }, 'OVERLAY_TEXT_TOO_LONG'],
    ['fontFamily', { fontFamily: 'Arial' }, 'OVERLAY_FONT_INVALID'],
    ['fontSize', { fontSize: 7 }, 'OVERLAY_FONT_SIZE_INVALID'],
    ['fontSize', { fontSize: 73 }, 'OVERLAY_FONT_SIZE_INVALID'],
    ['fontSize', { fontSize: 12.5 }, 'OVERLAY_FONT_SIZE_INVALID'],
    ['opacity', { opacity: 9 }, 'OVERLAY_OPACITY_INVALID'],
    ['opacity', { opacity: 101 }, 'OVERLAY_OPACITY_INVALID'],
    ['rotation', { rotation: -181 }, 'OVERLAY_ROTATION_INVALID'],
    ['rotation', { rotation: 181 }, 'OVERLAY_ROTATION_INVALID'],
    ['color', { color: 'red' }, 'OVERLAY_COLOR_INVALID'],
    ['linkUrl', { linkUrl: 'javascript:alert(1)' }, 'OVERLAY_LINK_INVALID'],
    ['linkUrl', { linkUrl: 'file:///tmp/a' }, 'OVERLAY_LINK_INVALID'],
    ['pageId', { pageId: 'removed-page' }, 'OVERLAY_PAGE_INVALID'],
  ])(
    'VT-09: rejects invalid %s with a field-scoped error',
    (field, overrides, code) => {
      const overlay = makeOverlay(overrides as Partial<OverlayTextBox>);
      const result = validateOverlays([overlay], PAGE_IDS);

      expect(result).toMatchObject({
        ok: false,
        errors: [
          expect.objectContaining({
            overlayId: overlay.id,
            field,
            code,
          }),
        ],
      });
    }
  );

  it('VT-09: clamps minimum size and keeps the box fully on-page', () => {
    const result = validateOverlays(
      [makeOverlay({ x: 99, y: 99, width: 1, height: 1 })],
      PAGE_IDS
    );

    expect(result).toEqual({
      ok: true,
      overlays: [
        expect.objectContaining({
          x: 95,
          y: 97,
          width: 5,
          height: 3,
        }),
      ],
    });
  });

  it('accepts smaller per-item geometry for replacement overlays', () => {
    const result = validateOverlays(
      [
        makeOverlay({
          kind: 'replace',
          backgroundColor: '#FFFFFF',
          width: 0.1,
          height: 0.1,
        }),
      ],
      PAGE_IDS
    );

    expect(result).toEqual({
      ok: true,
      overlays: [
        expect.objectContaining({
          kind: 'replace',
          width: 0.25,
          height: 0.25,
        }),
      ],
    });
  });

  it('requires a valid cover color for replacement overlays', () => {
    const result = validateOverlays(
      [makeOverlay({ kind: 'replace', backgroundColor: null })],
      PAGE_IDS
    );

    expect(result).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          field: 'backgroundColor',
          code: 'OVERLAY_BACKGROUND_COLOR_REQUIRED',
        }),
      ],
    });
  });

  it('VT-08: collects errors from multiple overlays in one result', () => {
    const result = validateOverlays(
      [
        makeOverlay({ fontSize: 7 }),
        makeOverlay({ text: 'x'.repeat(2_001) }, 1),
      ],
      PAGE_IDS
    );

    expect(result.ok).toBe(false);
    expect(errorFields(result)).toEqual(
      expect.arrayContaining(['fontSize', 'text'])
    );
  });

  it('rejects a malformed request body without throwing', () => {
    expect(validateOverlays(undefined, PAGE_IDS)).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          field: 'overlays',
          code: 'OVERLAYS_INVALID',
        }),
      ],
    });
  });

  it.each([
    'Roboto',
    'Open Sans',
    'Lato',
    'Montserrat',
    'Merriweather',
    'Noto Sans',
  ])('accepts Google font %s', (fontFamily) => {
    const result = validateOverlays(
      [makeOverlay({ fontFamily: fontFamily as OverlayFontFamily })],
      PAGE_IDS
    );
    expect(result.ok).toBe(true);
  });

  it('error message for invalid fontFamily lists all supported families', () => {
    const result = validateOverlays(
      [makeOverlay({ fontFamily: 'Arial' as OverlayFontFamily })],
      PAGE_IDS
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          field: 'fontFamily',
          code: 'OVERLAY_FONT_INVALID',
          message: expect.stringContaining('Roboto'),
        }),
      ],
    });
  });
});
