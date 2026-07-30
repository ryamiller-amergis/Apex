# PDF Google Fonts Design

## Goal

Expand PDF overlay text beyond the three standard PDF families while preserving
reliable preview, save, and export behavior. Apex will offer six bundled,
open-license Google Fonts:

- Roboto
- Open Sans
- Lato
- Montserrat
- Merriweather
- Noto Sans

Helvetica, Times-Roman, and Courier remain supported so existing sessions and
saved overlays continue to work unchanged.

## Architecture

Google Fonts is the source of the licensed font files, but Apex will not call
the Google Fonts CSS API while previewing or exporting a document. Regular,
bold, italic, and bold-italic font files will be stored under
`public/fonts/pdf/` with their license notices.

The client will load those local files through `@font-face` declarations so the
editor preview uses the same font data as export. The server will read the same
local files and use `@pdf-lib/fontkit` with `pdf-lib` to embed only the variants
used by overlays in the exported PDF. This avoids an internet dependency and
keeps exported documents portable.

## Font Selection and Replacement Detection

The font dropdown will contain the existing three families plus the six new
Google Fonts. A user's selection is persisted in the overlay's `fontFamily`
field, restored with the session, and embedded during export.

When replacement text is created from native PDF text, Apex will use a hybrid
selection strategy:

1. Normalize subset prefixes and style suffixes from PDF font metadata.
2. Select an exact supported family when the metadata identifies one.
3. Apply deterministic compatibility mappings: Calibri, Aptos, and Segoe UI to
   Roboto; Arial-compatible names to Helvetica; Times New Roman-compatible names
   to Times-Roman; other recognized sans-serif names to Roboto; other recognized
   serif names to Merriweather; and monospace names to Courier.
4. Fall back to Helvetica when metadata is missing or cannot be classified.
5. Allow the user to override the detected result from the dropdown; the
   override becomes the saved authoritative value.

Detection is best-effort. Apex will not extract or reuse arbitrary embedded
fonts from uploaded PDFs because subsetted names, incomplete glyph sets, and
font licensing make that unreliable.

## Data Flow

1. The editor extracts native text metadata through PDF.js.
2. Font normalization chooses an initial supported family.
3. The overlay editor previews the locally hosted font and saves its family
   name through the existing overlay autosave flow.
4. Existing server validation accepts only the centralized supported-family
   allowlist.
5. Export registers fontkit, loads each required local variant once, subsets
   and embeds it, then uses the embedded font for wrapping and drawing.

No database migration or API shape change is required because `fontFamily` is
already persisted as a string within overlay JSON.

## Failure Handling

- Missing or unreadable bundled font files fail export with a specific
  font-asset error rather than silently changing the user's selected font.
- Unsupported persisted values are rejected by validation.
- Existing standard-font overlays continue through the current `pdf-lib`
  standard-font path.
- Preview declarations include generic CSS fallbacks for transient browser
  loading failures, but the selected family remains unchanged.
- Deployment verification will confirm that all font files and license notices
  are present in the packaged application.

## Performance

Only font variants used in the current export are loaded and embedded. Fonts
are cached per export document, matching the existing standard-font cache
behavior. Custom fonts will increase exported file size, but subsetting limits
the increase to glyphs used by the document where supported by fontkit.

## Testing

- Shared type guards accept all supported families and reject unknown values.
- Server validation uses the same family catalog and reports invalid values.
- Native-text detection covers exact names, subsetted names, style suffixes,
  generic family mapping, and missing metadata.
- The toolbar lists every family and persists a manual override.
- Preview uses the correct local CSS font family.
- Export embeds regular, bold, italic, and bold-italic variants and caches each
  used variant once.
- Existing Helvetica, Times-Roman, and Courier export tests remain passing.
- A production build verifies that bundled font assets are available.

## Scope

This change does not add live Google Fonts API calls, user-uploaded fonts,
arbitrary font extraction, a database migration, or new permissions. Adding or
removing catalog families later will require updating the centralized catalog,
bundled assets, license notices, and focused tests.
