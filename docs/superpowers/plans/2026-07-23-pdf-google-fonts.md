# PDF Google Fonts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six bundled, open-license Google Fonts (Roboto, Open Sans, Lato, Montserrat, Merriweather, Noto Sans) to PDF overlay text — selectable in the toolbar, auto-detected for replacement text with a saved override, previewed in the editor, and embedded in exported PDFs — while keeping the existing Helvetica, Times-Roman, and Courier families working unchanged.

**Architecture:** A single shared font catalog in `src/shared/types/pdf.ts` becomes the source of truth for the allowlist consumed by the shared type guard, server overlay validation, and client formatting. The browser previews fonts via locally bundled `@font-face` files (no Google Fonts network calls); the server embeds only the variants used per export with `@pdf-lib/fontkit`. Replacement-text detection maps recognized PDF font metadata to the closest supported family, and the user can override the result from the dropdown.

**Tech Stack:** TypeScript, React 18, Vite, Express, `pdf-lib`, `@pdf-lib/fontkit`, `pdfjs-dist`, Jest, `@testing-library/react`.

## Global Constraints

- Preserve backward compatibility: `Helvetica`, `Times-Roman`, and `Courier` must remain valid, embed via `pdf-lib` `StandardFonts`, and pass all existing tests.
- No live Google Fonts CSS API calls during preview or export. Fonts are bundled locally under `public/fonts/pdf/`.
- No database migration and no overlay API shape change — `fontFamily` stays a string on `OverlayTextBox`.
- Only families in the shared catalog are accepted by client and server validation (identical allowlist).
- Do not modify protected files without noting it: this plan does **not** change `vite.config.ts`, `src/server/index.ts`, `tsconfig*.json`, or `jest.config.*`. It **does** change `package.json` + lockfile to add `@pdf-lib/fontkit` (explicitly approved by the developer).
- Follow repo rules: functional `React.FC` components, CSS via existing patterns, no `any`/`@ts-ignore`, run `tsc` after edits.
- New/renamed exported symbols used across tasks:
  - `PDF_OVERLAY_FONT_FAMILIES` (shared, `readonly OverlayFontFamily[]`)
  - `OverlayFontFamily` (shared, derived type)
  - `mapPdfFontToOverlayFamily(hint: string): OverlayFontFamily` (client util)
  - `createOverlayFontCache(document, overlays)` (server, replaces `createStandardFontCache`)
  - `readCustomFontBytes(family, variant)` and `resolveCustomFontPath(family, variant)` (server)

---

## Task 1: Shared font catalog + type guard

**Files:**
- Modify: `src/shared/types/pdf.ts:10` (the `OverlayFontFamily` type) and `src/shared/types/pdf.ts:66` (the guard allowlist)
- Test: `src/server/__tests__/pdfOverlayDataModel.test.ts` (existing — extend), and add assertions in `src/server/__tests__/overlayValidation.test.ts` (Task 2)

**Interfaces:**
- Produces: `export const PDF_OVERLAY_FONT_FAMILIES` and `export type OverlayFontFamily = (typeof PDF_OVERLAY_FONT_FAMILIES)[number];` consumed by Tasks 2, 3, 4, 6.

- [ ] **Step 1: Write the failing test**

Add to `src/server/__tests__/pdfOverlayDataModel.test.ts`:

```ts
import {
  PDF_OVERLAY_FONT_FAMILIES,
  isOverlayTextBox,
} from '../../shared/types/pdf';

describe('PDF_OVERLAY_FONT_FAMILIES catalog', () => {
  it('includes the legacy families and the six Google fonts', () => {
    expect(PDF_OVERLAY_FONT_FAMILIES).toEqual([
      'Helvetica',
      'Times-Roman',
      'Courier',
      'Roboto',
      'Open Sans',
      'Lato',
      'Montserrat',
      'Merriweather',
      'Noto Sans',
    ]);
  });

  it('accepts an overlay using a new Google font', () => {
    const overlay = {
      id: '11111111-1111-1111-8111-111111111111',
      pageId: 'p1',
      x: 1, y: 1, width: 10, height: 5,
      text: 'Hi',
      fontFamily: 'Roboto',
      fontSize: 12,
      bold: false, italic: false,
      color: '#000000',
      horizontalAlign: 'left', verticalAlign: 'top',
      opacity: 100, rotation: 0, listStyle: 'none', zIndex: 1,
    };
    expect(isOverlayTextBox(overlay)).toBe(true);
  });

  it('rejects an unknown font family', () => {
    const overlay = {
      id: '11111111-1111-1111-8111-111111111111',
      pageId: 'p1', x: 1, y: 1, width: 10, height: 5, text: 'Hi',
      fontFamily: 'Comic Sans', fontSize: 12, bold: false, italic: false,
      color: '#000000', horizontalAlign: 'left', verticalAlign: 'top',
      opacity: 100, rotation: 0, listStyle: 'none', zIndex: 1,
    };
    expect(isOverlayTextBox(overlay)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/server/__tests__/pdfOverlayDataModel.test.ts -t "catalog" --passWithNoTests`
Expected: FAIL — `PDF_OVERLAY_FONT_FAMILIES` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/shared/types/pdf.ts`, replace the `OverlayFontFamily` type declaration (line 10):

```ts
export const PDF_OVERLAY_FONT_FAMILIES = [
  'Helvetica',
  'Times-Roman',
  'Courier',
  'Roboto',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Merriweather',
  'Noto Sans',
] as const;

export type OverlayFontFamily = (typeof PDF_OVERLAY_FONT_FAMILIES)[number];
```

Then update the guard allowlist (was line 66) to reuse the catalog:

```ts
    (PDF_OVERLAY_FONT_FAMILIES as readonly string[]).includes(
      overlay.fontFamily as string
    ) &&
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/server/__tests__/pdfOverlayDataModel.test.ts --passWithNoTests`
Expected: PASS

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/pdf.ts src/server/__tests__/pdfOverlayDataModel.test.ts
git commit -m "feat(pdf): add shared Google font catalog to overlay types"
```

---

## Task 2: Server overlay validation uses the shared catalog

**Files:**
- Modify: `src/server/services/overlayValidation.ts:16` (the `FONT_FAMILIES` set) and `:170` (the error message)
- Test: `src/server/__tests__/overlayValidation.test.ts`

**Interfaces:**
- Consumes: `PDF_OVERLAY_FONT_FAMILIES` from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `src/server/__tests__/overlayValidation.test.ts` (inside the existing describe block; it already imports `validateOverlays` and builds overlays):

```ts
it('accepts a new Google font family', () => {
  const pageIds = new Set(['p1']);
  const result = validateOverlays(
    [{ ...baseOverlay, fontFamily: 'Montserrat' }],
    pageIds
  );
  expect(result.ok).toBe(true);
});
```

If the file has no shared `baseOverlay`, reuse the existing overlay factory already present in that test file; only override `fontFamily: 'Montserrat'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/server/__tests__/overlayValidation.test.ts -t "Google font" --passWithNoTests`
Expected: FAIL — `Montserrat` reported as `OVERLAY_FONT_INVALID`.

- [ ] **Step 3: Write minimal implementation**

In `src/server/services/overlayValidation.ts`, add the import at the top:

```ts
import { PDF_OVERLAY_FONT_FAMILIES } from '../../shared/types/pdf';
```

Replace line 16:

```ts
const FONT_FAMILIES = new Set<string>(PDF_OVERLAY_FONT_FAMILIES);
```

Replace the error message (line ~170):

```ts
        `fontFamily must be one of: ${PDF_OVERLAY_FONT_FAMILIES.join(', ')}.`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/server/__tests__/overlayValidation.test.ts --passWithNoTests`
Expected: PASS (including the existing `['fontFamily', { fontFamily: 'Arial' }, 'OVERLAY_FONT_INVALID']` case).

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/services/overlayValidation.ts src/server/__tests__/overlayValidation.test.ts
git commit -m "feat(pdf): validate overlay fonts against shared catalog"
```

---

## Task 3: Client font catalog, CSS stacks, and dropdown labels

**Files:**
- Modify: `src/client/hooks/overlayFormatting.ts:6-16` (`OVERLAY_FONT_FAMILIES` + `OVERLAY_FONT_STACKS`)
- Modify: `src/client/components/OverlayFormatToolbar.tsx:287-291` (render friendly labels)
- Test: `src/client/hooks/__tests__/overlayFormatting.test.ts` (create if absent) and `src/client/components/__tests__/OverlayFormatToolbar.test.tsx`

**Interfaces:**
- Consumes: `PDF_OVERLAY_FONT_FAMILIES`, `OverlayFontFamily` from Task 1.
- Produces: `OVERLAY_FONT_FAMILIES`, `OVERLAY_FONT_STACKS`, and `OVERLAY_FONT_LABELS` consumed by the toolbar (Task 3) and preview (`OverlayTextBox`, Task 5).

- [ ] **Step 1: Write the failing test**

Create `src/client/hooks/__tests__/overlayFormatting.test.ts`:

```ts
import {
  OVERLAY_FONT_FAMILIES,
  OVERLAY_FONT_STACKS,
  OVERLAY_FONT_LABELS,
} from '../overlayFormatting';

describe('overlay font formatting catalog', () => {
  it('exposes all nine families with a CSS stack and label each', () => {
    expect(OVERLAY_FONT_FAMILIES).toHaveLength(9);
    for (const family of OVERLAY_FONT_FAMILIES) {
      expect(OVERLAY_FONT_STACKS[family]).toBeTruthy();
      expect(OVERLAY_FONT_LABELS[family]).toBeTruthy();
    }
  });

  it('maps the legacy Times-Roman family to a serif stack and readable label', () => {
    expect(OVERLAY_FONT_STACKS['Times-Roman']).toContain('serif');
    expect(OVERLAY_FONT_LABELS['Times-Roman']).toBe('Times New Roman');
  });

  it('maps Roboto to its own CSS family', () => {
    expect(OVERLAY_FONT_STACKS['Roboto']).toContain('Roboto');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/client/hooks/__tests__/overlayFormatting.test.ts --passWithNoTests`
Expected: FAIL — `OVERLAY_FONT_LABELS` not exported / only three families present.

- [ ] **Step 3: Write minimal implementation**

Replace the top of `src/client/hooks/overlayFormatting.ts`:

```ts
import { PDF_OVERLAY_FONT_FAMILIES } from '../../shared/types/pdf';
import type {
  OverlayFontFamily,
  OverlayListStyle,
} from '../../shared/types/pdf';

export const OVERLAY_FONT_FAMILIES: readonly OverlayFontFamily[] =
  PDF_OVERLAY_FONT_FAMILIES;

export const OVERLAY_FONT_STACKS: Record<OverlayFontFamily, string> = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  'Times-Roman': '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
  Roboto: "'Roboto', Arial, sans-serif",
  'Open Sans': "'Open Sans', Arial, sans-serif",
  Lato: "'Lato', Arial, sans-serif",
  Montserrat: "'Montserrat', Arial, sans-serif",
  Merriweather: "'Merriweather', Georgia, serif",
  'Noto Sans': "'Noto Sans', Arial, sans-serif",
};

export const OVERLAY_FONT_LABELS: Record<OverlayFontFamily, string> = {
  Helvetica: 'Helvetica',
  'Times-Roman': 'Times New Roman',
  Courier: 'Courier',
  Roboto: 'Roboto',
  'Open Sans': 'Open Sans',
  Lato: 'Lato',
  Montserrat: 'Montserrat',
  Merriweather: 'Merriweather',
  'Noto Sans': 'Noto Sans',
};
```

Keep the remaining exports (`MIN_OVERLAY_FONT_SIZE`, etc.) unchanged.

In `src/client/components/OverlayFormatToolbar.tsx`, import the label map and render labels (replace the `.map` at lines 287-291):

```tsx
              {OVERLAY_FONT_FAMILIES.map((font) => (
                <option key={font} value={font}>
                  {OVERLAY_FONT_LABELS[font]}
                </option>
              ))}
```

Add `OVERLAY_FONT_LABELS` to the existing import from `'../hooks/overlayFormatting'`.

- [ ] **Step 4: Update the existing toolbar test expectation**

In `src/client/components/__tests__/OverlayFormatToolbar.test.tsx`, the option value stays `'Times-Roman'` (unchanged), so the existing `target: { value: 'Times-Roman' }` interactions still pass. Add one assertion that the new option renders:

```tsx
it('lists the new Google fonts in the family dropdown', () => {
  render(<OverlayFormatToolbar overlay={overlay} onChange={jest.fn()} />);
  const select = screen.getByTestId('overlay-format-font-family');
  expect(select).toContainHTML('Montserrat');
  expect(select).toContainHTML('Noto Sans');
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/client/hooks/__tests__/overlayFormatting.test.ts src/client/components/__tests__/OverlayFormatToolbar.test.tsx --passWithNoTests`
Expected: PASS

- [ ] **Step 6: Type-check**

Run: `npx tsc -p tsconfig.client.json --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/client/hooks/overlayFormatting.ts src/client/components/OverlayFormatToolbar.tsx src/client/hooks/__tests__/overlayFormatting.test.ts src/client/components/__tests__/OverlayFormatToolbar.test.tsx
git commit -m "feat(pdf): expose Google fonts in overlay toolbar with labels"
```

---

## Task 4: Replacement-text font detection mapping

**Files:**
- Modify: `src/client/utils/pdfNativeTextItems.ts:58-108` (hint lists + `inferFontStyle`; export a pure `mapPdfFontToOverlayFamily`)
- Test: `src/client/utils/__tests__/pdfNativeTextItems.test.ts`

**Interfaces:**
- Consumes: `OverlayFontFamily` from Task 1.
- Produces: `export function mapPdfFontToOverlayFamily(hint: string): OverlayFontFamily` consumed by tests and internally by `inferFontStyle`.

- [ ] **Step 1: Write the failing test**

Add to `src/client/utils/__tests__/pdfNativeTextItems.test.ts`:

```ts
import { mapPdfFontToOverlayFamily } from '../pdfNativeTextItems';

describe('mapPdfFontToOverlayFamily', () => {
  it.each([
    ['ABCDEF+Calibri', 'Roboto'],
    ['Aptos-Bold', 'Roboto'],
    ['Segoe UI Semibold', 'Roboto'],
    ['ArialMT', 'Helvetica'],
    ['Helvetica-Oblique', 'Helvetica'],
    ['TimesNewRomanPSMT', 'Times-Roman'],
    ['Georgia-Italic', 'Merriweather'],
    ['Garamond', 'Merriweather'],
    ['CourierNewPS-BoldMT', 'Courier'],
    ['Consolas', 'Courier'],
    ['Verdana', 'Roboto'],
    ['', 'Helvetica'],
  ])('maps %s -> %s', (hint, expected) => {
    expect(mapPdfFontToOverlayFamily(hint)).toBe(expected);
  });
});
```

Note: the existing parametrized test at lines 44-47 asserts `'Arial-Semibold' -> 'Helvetica'` and `'f-serif'/'Cambria Italic' -> 'Times-Roman'`. Update those two expectations that change under the new mapping: `Cambria` is a serif → now `Merriweather` (update the existing row from `'Times-Roman'` to `'Merriweather'`). `Arial-Semibold` stays `Helvetica`. Leave generated/undefined rows mapping to `Helvetica`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/client/utils/__tests__/pdfNativeTextItems.test.ts -t "mapPdfFontToOverlayFamily" --passWithNoTests`
Expected: FAIL — function not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/client/utils/pdfNativeTextItems.ts`, replace the hint lists and `inferFontStyle` (lines 58-108) with:

```ts
const MONOSPACE_HINTS = ['courier', 'mono', 'consolas', 'menlo', 'typewriter'];
const ROBOTO_SANS_HINTS = ['calibri', 'aptos', 'segoe'];
const HELVETICA_SANS_HINTS = ['helvetica', 'arial'];
const TIMES_SERIF_HINTS = ['times', 'timesnewroman'];
const SERIF_HINTS = ['serif', 'roman', 'georgia', 'garamond', 'cambria'];
const SANS_HINTS = ['sans', 'verdana', 'tahoma', 'roboto', 'lato', 'montserrat'];
const BOLD_HINTS = ['bold', 'black', 'heavy', 'demi', 'semibold'];
const ITALIC_HINTS = ['italic', 'oblique', 'slanted'];

function normalizeFontHint(hint: string): string {
  return hint.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Maps recognized PDF font metadata to the closest supported overlay family.
 * Best-effort: subsetted/renamed embedded fonts fall back to Helvetica.
 */
export function mapPdfFontToOverlayFamily(hint: string): OverlayFontFamily {
  const normalized = normalizeFontHint(hint);
  const compact = normalized.replace(/\s+/g, '');
  const contains = (values: readonly string[]) =>
    values.some((value) => normalized.includes(value) || compact.includes(value));

  if (contains(MONOSPACE_HINTS)) return 'Courier';
  if (contains(TIMES_SERIF_HINTS)) return 'Times-Roman';
  if (contains(HELVETICA_SANS_HINTS)) return 'Helvetica';
  if (contains(ROBOTO_SANS_HINTS)) return 'Roboto';
  if (contains(SERIF_HINTS)) return 'Merriweather';
  if (contains(SANS_HINTS)) return 'Roboto';
  return 'Helvetica';
}

function inferFontStyle(
  fontName: string,
  style: PdfTextStyleLike | undefined
): InferredFontStyle {
  const hint = `${style?.fontFamily ?? ''} ${fontName}`;
  const normalized = normalizeFontHint(hint);
  const contains = (values: readonly string[]) =>
    values.some((value) => normalized.includes(value));

  return {
    fontFamily: mapPdfFontToOverlayFamily(hint),
    bold: contains(BOLD_HINTS),
    italic: contains(ITALIC_HINTS),
  };
}
```

Ordering rationale: monospace and Times are checked before generic serif so `CourierNewPS` and `TimesNewRoman` win; Helvetica/Arial before generic sans so Arial stays Helvetica.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/client/utils/__tests__/pdfNativeTextItems.test.ts --passWithNoTests`
Expected: PASS (update any pre-existing row expectations noted in Step 1).

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.client.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client/utils/pdfNativeTextItems.ts src/client/utils/__tests__/pdfNativeTextItems.test.ts
git commit -m "feat(pdf): map detected PDF fonts to supported overlay families"
```

---

## Task 5: Bundle font assets and wire browser preview `@font-face`

**Files:**
- Create: `scripts/fetch-pdf-fonts.mjs` (one-time asset downloader)
- Create: `public/fonts/pdf/*.ttf` (24 files: 6 families × 4 variants)
- Create: `public/fonts/pdf/LICENSES.md`
- Create: `src/client/components/pdfOverlayFonts.css`
- Modify: `src/client/components/OverlayTextBox.tsx:14` (import the stylesheet so `@font-face` loads wherever overlays render)

**Interfaces:**
- Consumes: `OVERLAY_FONT_STACKS` CSS family names from Task 3 (the `@font-face` `font-family` values must match exactly: `Roboto`, `Open Sans`, `Lato`, `Montserrat`, `Merriweather`, `Noto Sans`).
- Produces: local font files at predictable paths (`public/fonts/pdf/<Family>-<Variant>.ttf`) consumed by the server embedder in Task 6.

- [ ] **Step 1: Create the downloader script**

Create `scripts/fetch-pdf-fonts.mjs`:

```js
// Downloads static TTF variants for the six bundled PDF fonts from the
// google-webfonts-helper API (fonts served under their OFL/Apache licenses).
// Usage: node scripts/fetch-pdf-fonts.mjs
import { mkdirSync, writeFileSync, createWriteStream, readdirSync, renameSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const OUT_DIR = join(process.cwd(), 'public', 'fonts', 'pdf');
const TMP_DIR = join(OUT_DIR, '.tmp');
mkdirSync(OUT_DIR, { recursive: true });

// id = google-webfonts-helper font id; family = our catalog + CSS family; file = filename prefix
const FONTS = [
  { id: 'roboto', family: 'Roboto', file: 'Roboto' },
  { id: 'open-sans', family: 'Open Sans', file: 'OpenSans' },
  { id: 'lato', family: 'Lato', file: 'Lato' },
  { id: 'montserrat', family: 'Montserrat', file: 'Montserrat' },
  { id: 'merriweather', family: 'Merriweather', file: 'Merriweather' },
  { id: 'noto-sans', family: 'Noto Sans', file: 'NotoSans' },
];

// gwfh variant id -> our variant suffix
const VARIANTS = [
  { gwfh: 'regular', suffix: 'Regular' },
  { gwfh: '700', suffix: 'Bold' },
  { gwfh: 'italic', suffix: 'Italic' },
  { gwfh: '700italic', suffix: 'BoldItalic' },
];

async function main() {
  for (const font of FONTS) {
    const zipUrl =
      `https://gwfh.mranftl.com/api/fonts/${font.id}` +
      `?download=zip&formats=ttf&variants=regular,italic,700,700italic`;
    const zipPath = join(TMP_DIR, `${font.id}.zip`);
    const extractDir = join(TMP_DIR, font.id);
    mkdirSync(extractDir, { recursive: true });

    console.log(`Downloading ${font.family}…`);
    const res = await fetch(zipUrl);
    if (!res.ok) throw new Error(`Failed ${font.id}: ${res.status}`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));

    // Windows 10+ ships bsdtar, which extracts .zip via `tar -xf`.
    execSync(`tar -xf "${zipPath}" -C "${extractDir}"`, { stdio: 'inherit' });

    const files = readdirSync(extractDir);
    for (const variant of VARIANTS) {
      // gwfh names files like `<id>-v<n>-latin-<variant>.ttf`
      const match = files.find((f) =>
        f.toLowerCase().endsWith(`-${variant.gwfh}.ttf`)
      );
      if (!match) throw new Error(`Missing ${font.id} ${variant.gwfh}`);
      const dest = join(OUT_DIR, `${font.file}-${variant.suffix}.ttf`);
      renameSync(join(extractDir, match), dest);
      console.log(`  wrote ${font.file}-${variant.suffix}.ttf`);
    }
  }
  rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the downloader and verify assets**

Run: `node scripts/fetch-pdf-fonts.mjs`
Expected: 24 files written. Verify:

Run (PowerShell): `(Get-ChildItem public/fonts/pdf/*.ttf).Count`
Expected: `24`

If `gwfh.mranftl.com` is unavailable, fall back to raw static TTFs from `https://cdn.jsdelivr.net/gh/google/fonts@main/<license>/<id>/static/...` for each family, saving the same 24 filenames. Confirm each file opens as a font in Step 5.

- [ ] **Step 3: Record licenses**

Create `public/fonts/pdf/LICENSES.md`:

```markdown
# Bundled PDF Fonts

These fonts are bundled for local preview and PDF embedding. No runtime Google Fonts API calls are made.

| Family | License |
|--------|---------|
| Roboto | Apache License 2.0 |
| Open Sans | SIL Open Font License 1.1 |
| Lato | SIL Open Font License 1.1 |
| Montserrat | SIL Open Font License 1.1 |
| Merriweather | SIL Open Font License 1.1 |
| Noto Sans | SIL Open Font License 1.1 |

Full license texts: https://fonts.google.com/ (per family "About" tab).
```

- [ ] **Step 4: Create the `@font-face` stylesheet**

Create `src/client/components/pdfOverlayFonts.css` (one block per family shown; repeat the four faces for each of Roboto, Open Sans, Lato, Montserrat, Merriweather, Noto Sans, matching the filenames from Step 2):

```css
@font-face {
  font-family: 'Roboto';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/pdf/Roboto-Regular.ttf') format('truetype');
}
@font-face {
  font-family: 'Roboto';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/pdf/Roboto-Bold.ttf') format('truetype');
}
@font-face {
  font-family: 'Roboto';
  font-style: italic;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/pdf/Roboto-Italic.ttf') format('truetype');
}
@font-face {
  font-family: 'Roboto';
  font-style: italic;
  font-weight: 700;
  font-display: swap;
  src: url('/fonts/pdf/Roboto-BoldItalic.ttf') format('truetype');
}

/* Repeat the four faces above for: 'Open Sans' (OpenSans-*.ttf),
   'Lato' (Lato-*.ttf), 'Montserrat' (Montserrat-*.ttf),
   'Merriweather' (Merriweather-*.ttf), 'Noto Sans' (NotoSans-*.ttf). */
```

- [ ] **Step 5: Import the stylesheet in the overlay renderer**

In `src/client/components/OverlayTextBox.tsx`, add after the existing module-css import (line 14):

```tsx
import './pdfOverlayFonts.css';
```

Sanity-check each downloaded TTF is a valid font (run once):

Run: `node -e "const fs=require('fs');for(const f of fs.readdirSync('public/fonts/pdf').filter(f=>f.endsWith('.ttf'))){const b=fs.readFileSync('public/fonts/pdf/'+f);const t=b.toString('ascii',0,4);if(!['\\u0000\\u0001\\u0000\\u0000','OTTO','true','ttcf'].includes(t))throw new Error('bad '+f);}console.log('ok')"`
Expected: `ok`

- [ ] **Step 6: Type-check the client**

Run: `npx tsc -p tsconfig.client.json --noEmit`
Expected: no errors (CSS import is side-effect only).

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-pdf-fonts.mjs public/fonts/pdf src/client/components/pdfOverlayFonts.css src/client/components/OverlayTextBox.tsx
git commit -m "feat(pdf): bundle Google font assets and preview @font-face"
```

---

## Task 6: Embed custom fonts during export

**Files:**
- Add dependency: `@pdf-lib/fontkit` (via `npm install @pdf-lib/fontkit` — updates `package.json` + `package-lock.json`)
- Modify: `src/server/services/pdfOverlayBurnIn.ts` (add fontkit registration, custom-font file resolution + embedding; rename `createStandardFontCache` → `createOverlayFontCache`)
- Modify: `src/server/workers/pdfExportWorker.ts:8,121` (import + call the renamed function)
- Modify: `src/server/__tests__/pdfOverlayBurnIn.test.ts:5,37` (import + helper use the renamed function; add custom-font tests)

**Interfaces:**
- Consumes: `PDF_OVERLAY_FONT_FAMILIES`, `OverlayFontFamily`, `OverlayTextBox` from Task 1; bundled TTF paths from Task 5.
- Produces: `createOverlayFontCache(document, overlays)` (async, returns `StandardFontCache`), `resolveCustomFontPath(family, variant)`, `readCustomFontBytes(family, variant)`. `burnOverlaysOntoPage` signature is unchanged.

- [ ] **Step 1: Install the dependency**

Run: `npm install @pdf-lib/fontkit`
Expected: `package.json` dependencies include `@pdf-lib/fontkit`; lockfile updated.

- [ ] **Step 2: Write the failing tests**

Add to `src/server/__tests__/pdfOverlayBurnIn.test.ts`. First update the existing import and helper to the new name:

```ts
import {
  burnOverlaysOntoPage,
  createOverlayFontCache,
  resolveCustomFontPath,
} from '../services/pdfOverlayBurnIn';
```

Update the helper `createPage` to call `createOverlayFontCache` instead of `createStandardFontCache`.

Then add:

```ts
describe('createOverlayFontCache — custom fonts', () => {
  it('resolves a bundled font path by family and variant', () => {
    expect(resolveCustomFontPath('Roboto', 'boldItalic')).toMatch(
      /public[\\/]fonts[\\/]pdf[\\/]Roboto-BoldItalic\.ttf$/
    );
    expect(resolveCustomFontPath('Noto Sans', 'regular')).toMatch(
      /NotoSans-Regular\.ttf$/
    );
  });

  it('registers fontkit and embeds a custom font from bundled bytes', async () => {
    const document = await PDFDocument.create();
    const registerSpy = jest.spyOn(document, 'registerFontkit');
    const fakeFont = { name: 'Roboto' } as unknown as never;
    const embedSpy = jest
      .spyOn(document, 'embedFont')
      .mockResolvedValue(fakeFont);

    const overlays = [makeOverlay({ fontFamily: 'Roboto', bold: true })];
    const cache = await createOverlayFontCache(document, overlays);

    expect(registerSpy).toHaveBeenCalled();
    expect(embedSpy).toHaveBeenCalledWith(expect.anything(), { subset: true });
    expect(cache.size).toBe(1);
  });

  it('still embeds standard fonts without fontkit', async () => {
    const document = await PDFDocument.create();
    const registerSpy = jest.spyOn(document, 'registerFontkit');
    const overlays = [makeOverlay({ fontFamily: 'Helvetica' })];
    const cache = await createOverlayFontCache(document, overlays);
    expect(cache.size).toBe(1);
    expect(registerSpy).not.toHaveBeenCalled();
  });
});
```

Note: the custom-font test depends on Task 5 assets being present (real `Roboto-Bold.ttf`); `embedFont` is mocked so the bytes only need to exist on disk. Ensure `makeOverlay` accepts `fontFamily` overrides (it already spreads `overrides`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/server/__tests__/pdfOverlayBurnIn.test.ts --passWithNoTests`
Expected: FAIL — `createOverlayFontCache`/`resolveCustomFontPath` not exported.

- [ ] **Step 4: Write the implementation**

In `src/server/services/pdfOverlayBurnIn.ts`:

Add imports at the top:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
```

Add below `STANDARD_FONT_NAMES`:

```ts
type FontVariant = 'regular' | 'bold' | 'italic' | 'boldItalic';

const STANDARD_FAMILIES = new Set<OverlayFontFamily>([
  'Helvetica',
  'Times-Roman',
  'Courier',
]);

const CUSTOM_FONT_FILE_PREFIX: Partial<Record<OverlayFontFamily, string>> = {
  Roboto: 'Roboto',
  'Open Sans': 'OpenSans',
  Lato: 'Lato',
  Montserrat: 'Montserrat',
  Merriweather: 'Merriweather',
  'Noto Sans': 'NotoSans',
};

const VARIANT_FILE_SUFFIX: Record<FontVariant, string> = {
  regular: 'Regular',
  bold: 'Bold',
  italic: 'Italic',
  boldItalic: 'BoldItalic',
};

function overlayVariant(overlay: OverlayTextBox): FontVariant {
  return overlay.bold
    ? overlay.italic
      ? 'boldItalic'
      : 'bold'
    : overlay.italic
      ? 'italic'
      : 'regular';
}

export function resolveCustomFontPath(
  family: OverlayFontFamily,
  variant: FontVariant
): string {
  const prefix = CUSTOM_FONT_FILE_PREFIX[family];
  if (!prefix) {
    throw new Error(`No bundled font for family ${family}`);
  }
  return path.resolve(
    process.cwd(),
    'public',
    'fonts',
    'pdf',
    `${prefix}-${VARIANT_FILE_SUFFIX[variant]}.ttf`
  );
}

export async function readCustomFontBytes(
  family: OverlayFontFamily,
  variant: FontVariant
): Promise<Buffer> {
  const filePath = resolveCustomFontPath(family, variant);
  try {
    return await fs.readFile(filePath);
  } catch {
    throw new Error(`Missing bundled font asset: ${filePath}`);
  }
}
```

Replace `createStandardFontCache` (lines 63-76) with:

```ts
/** Embeds each used font variant at most once for the complete export. */
export async function createOverlayFontCache(
  document: PDFDocument,
  overlays: OverlayTextBox[]
): Promise<StandardFontCache> {
  const cache: StandardFontCache = new Map();
  let fontkitRegistered = false;
  for (const overlay of overlays) {
    const key = fontKey(overlay);
    if (cache.has(key)) continue;

    if (STANDARD_FAMILIES.has(overlay.fontFamily)) {
      cache.set(key, await document.embedFont(standardFontName(overlay)));
      continue;
    }

    if (!fontkitRegistered) {
      document.registerFontkit(fontkit);
      fontkitRegistered = true;
    }
    const bytes = await readCustomFontBytes(
      overlay.fontFamily,
      overlayVariant(overlay)
    );
    cache.set(key, await document.embedFont(bytes, { subset: true }));
  }
  return cache;
}
```

`standardFontName` is only called for standard families now, so its `STANDARD_FONT_NAMES[overlay.fontFamily]` lookup stays safe. Leave `burnOverlaysOntoPage`, `fontKey`, and wrapping logic unchanged — they consume the cache by `fontKey` and work identically for embedded custom fonts.

- [ ] **Step 5: Update the export worker**

In `src/server/workers/pdfExportWorker.ts`, change the import (line 8) from `createStandardFontCache` to `createOverlayFontCache`, and the call (line 121):

```ts
    const fontCache = await createOverlayFontCache(outputDoc, overlays);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/server/__tests__/pdfOverlayBurnIn.test.ts src/server/__tests__/pdfExportWorker.test.ts --passWithNoTests`
Expected: PASS

- [ ] **Step 7: Type-check the server**

Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/server/services/pdfOverlayBurnIn.ts src/server/workers/pdfExportWorker.ts src/server/__tests__/pdfOverlayBurnIn.test.ts
git commit -m "feat(pdf): embed bundled Google fonts in exported PDFs"
```

---

## Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all suites pass. Pay attention to `PdfInlinePreview`, `OverlayTextLayer`, `PdfPageEditorModal`, `PdfAssemblyView.integration`, and `useOverlayEditor` — none should regress.

- [ ] **Step 2: Type-check both projects**

Run: `npx tsc -p tsconfig.client.json --noEmit`
Run: `npx tsc -p tsconfig.server.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint:check`
Expected: no new errors in changed files.

- [ ] **Step 4: Production build (confirms bundled assets ship)**

Run: `npm run build`
Expected: build succeeds; `dist/client/fonts/pdf/` contains the 24 `.ttf` files (Vite copies `public/`).

Run (PowerShell): `(Get-ChildItem dist/client/fonts/pdf/*.ttf).Count`
Expected: `24`

- [ ] **Step 5: Manual smoke (dev)**

With `npm run dev` running, open a PDF in PDF Tools, add a text box, select **Montserrat**, verify the preview font changes; enter replacement mode on native text and confirm a sensible family is auto-selected and can be overridden; export and confirm the chosen font renders in the output PDF.

## Self-Review

- **Spec coverage:** Goal/six fonts → Tasks 1,3,5; local bundling (no API) → Task 5; preview parity → Task 5; embedding used variants only → Task 6; hybrid detection + dropdown override → Tasks 3,4; validation allowlist parity → Tasks 1,2; failure handling (missing asset error) → Task 6 `readCustomFontBytes`; backward compatibility → Tasks 1,2,6 (`STANDARD_FAMILIES`) + Task 7; deployment asset verification → Task 7 Step 4; no migration/permissions → respected throughout.
- **Placeholder scan:** none — every code step shows concrete content; the `@font-face` repetition is explicitly enumerated by filename.
- **Type consistency:** `createOverlayFontCache` (renamed) used consistently in service, worker, and tests; `FontVariant`, `resolveCustomFontPath`, `readCustomFontBytes`, `mapPdfFontToOverlayFamily`, `PDF_OVERLAY_FONT_FAMILIES`, `OVERLAY_FONT_LABELS` referenced with the same names where produced.
