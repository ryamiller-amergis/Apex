import { LogoProviderError } from './logoImageProvider';

const MAX_SVG_BYTES = 64 * 1024;
const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
]);
const ALLOWED_ATTRIBUTES = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'transform',
  'd',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
]);
const BLOCKED_CONTENT =
  /<!|<\?|\b(?:href|xlink:href|src|style)\s*=|\bon[a-z-]+\s*=|url\s*\(|javascript:|data:/i;
const TAG_PATTERN = /<\/?([a-zA-Z][\w:-]*)(?:\s[^<>]*?)?\/?>/g;
const OPEN_TAG_PATTERN = /<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\/?>/g;
const ATTRIBUTE_PATTERN = /\s([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"[^"]*"|'[^']*')/g;

export function sanitizeLogoSvg(svg: string): string {
  const value = svg.trim();
  if (!value.startsWith('<svg') || !value.endsWith('</svg>')) {
    throw new LogoProviderError(
      'The Cursor model did not return a complete SVG logo.'
    );
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SVG_BYTES) {
    throw new LogoProviderError('The generated SVG logo is too large.');
  }
  if (BLOCKED_CONTENT.test(value)) {
    throw new LogoProviderError(
      'The generated SVG logo contains unsupported content.'
    );
  }

  let tagCount = 0;
  for (const match of value.matchAll(TAG_PATTERN)) {
    tagCount += 1;
    if (!ALLOWED_ELEMENTS.has(match[1])) {
      throw new LogoProviderError(
        `The generated SVG logo uses unsupported <${match[1]}> content.`
      );
    }
  }
  if (tagCount === 0) {
    throw new LogoProviderError(
      'The Cursor model did not return SVG elements.'
    );
  }

  for (const tag of value.matchAll(OPEN_TAG_PATTERN)) {
    const attributes = tag[2] ?? '';
    const stripped = attributes.replace(ATTRIBUTE_PATTERN, '');
    if (stripped.trim()) {
      throw new LogoProviderError(
        'The generated SVG logo has invalid attributes.'
      );
    }
    for (const attribute of attributes.matchAll(ATTRIBUTE_PATTERN)) {
      if (!ALLOWED_ATTRIBUTES.has(attribute[1])) {
        throw new LogoProviderError(
          `The generated SVG logo uses unsupported ${attribute[1]} content.`
        );
      }
    }
  }

  return value;
}
