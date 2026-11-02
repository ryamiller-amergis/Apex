import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TokenOverrides } from '../tokens/index.js';
import { CONTRAST_PAIRINGS, checkThemeContrast } from './contrast.js';
import { runContrastCli } from './contrastCli.js';

const failingDark: TokenOverrides = {
  colors: { dark: { text: { secondary: '#555555' } } },
};

describe('checkThemeContrast', () => {
  it('VT-04 TBI-020 DoD-3 default light and dark themes meet every pairing', () => {
    expect(checkThemeContrast()).toEqual([]);
  });

  it('VT-04 covers text, contrast-text, link, focus, and input-border pairings', () => {
    const labels = CONTRAST_PAIRINGS.map(
      (pair) => `${pair.foreground} on ${pair.background} >= ${pair.required}`
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        'text.primary on background.default >= 4.5',
        'text.secondary on background.paper >= 4.5',
        'primary.contrastText on primary.main >= 4.5',
        'success.contrastText on success.main >= 4.5',
        'primary.main on background.paper >= 4.5',
        'focus on background.default >= 3',
        'inputBorder on background.paper >= 3',
      ])
    );
  });

  it('VT-05 PBI-017 AC-1 names the scheme, token, pairing, ratio, and minimum', () => {
    const failures = checkThemeContrast(failingDark);
    expect(failures).toContainEqual(
      expect.objectContaining({
        scheme: 'dark',
        foreground: 'text.secondary',
        background: 'background.paper',
        required: 4.5,
      })
    );
    const failure = failures.find(
      (item) => item.background === 'background.paper'
    );
    expect(failure?.ratio).toBeGreaterThan(1);
    expect(failure?.ratio).toBeLessThan(4.5);
    expect(failures.every((item) => item.scheme === 'dark')).toBe(true);
  });

  it('VT-24 PBI-017 AC-1 reports an unparseable value with ratio null', () => {
    const failures = checkThemeContrast({
      colors: { light: { primary: { main: 'red' } } },
    });
    expect(failures).toContainEqual(
      expect.objectContaining({
        scheme: 'light',
        foreground: 'primary.main',
        ratio: null,
      })
    );
  });
});

// Vitest only loads modules inside the package root, so the fixtures live in
// the ignored node_modules cache rather than the system temp directory.
const fixtureRoot = path.resolve(
  import.meta.dirname,
  '../../node_modules/.cache'
);

describe('check:contrast CLI', () => {
  let dir: string;
  let lines: string[];
  const log = (line: string) => {
    lines.push(line);
  };

  beforeEach(() => {
    mkdirSync(fixtureRoot, { recursive: true });
    dir = mkdtempSync(path.join(fixtureRoot, 'contrast-'));
    lines = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeOverrides(name: string, overrides: TokenOverrides): string {
    const file = path.join(dir, name);
    writeFileSync(
      file,
      `export default ${JSON.stringify(overrides)};\n`,
      'utf8'
    );
    return file;
  }

  it('VT-04 exits 0 for the default tokens', async () => {
    expect(await runContrastCli([], { log })).toBe(0);
    expect(lines.join('\n')).toMatch(/pass/i);
  });

  it('VT-05 prints the failing pairing and exits 1 for an --overrides module', async () => {
    const file = writeOverrides('failing.mjs', failingDark);
    expect(await runContrastCli(['--overrides', file], { log })).toBe(1);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^dark: text\.secondary on background\.paper = \d+(\.\d+)?, needs 4\.5$/
      )
    );
  });

  it('VT-24 exits 1 and names an unparseable token', async () => {
    const file = writeOverrides('named.mjs', {
      colors: { light: { primary: { main: 'red' } } },
    });
    expect(await runContrastCli(['--overrides', file], { log })).toBe(1);
    expect(lines).toContainEqual(
      expect.stringMatching(/^light: primary\.main .*unparseable/)
    );
  });

  it('exits 2 when --overrides has no path', async () => {
    expect(await runContrastCli(['--overrides'], { log })).toBe(2);
  });
});
