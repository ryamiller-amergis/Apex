// Downloads static TTF variants for the six bundled PDF fonts from the
// google-webfonts-helper API (fonts served under their OFL/Apache licenses).
// Usage: node scripts/fetch-pdf-fonts.mjs
import { mkdirSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
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
