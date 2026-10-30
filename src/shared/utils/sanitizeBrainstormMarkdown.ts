/**
 * Allow-list pass over Brainstorm artifact Markdown before it is stored.
 *
 * Outside code, it removes every raw HTML element (and the bodies of elements
 * that hold script or embedded content), HTML comments, and `javascript:`,
 * `vbscript:` and `data:` link targets. Fenced code blocks, including Mermaid,
 * and inline code spans are returned byte for byte: the renderer shows them as text.
 */
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/;
const DANGEROUS_BODY = /<(script|style|iframe|object|embed|noscript|template|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?(-->|$)/g;
const SAFE_AUTOLINK = /<(?:https?:\/\/|mailto:)[^\s<>]+>/gi;
/** A start or end tag, including one left unclosed at the end of a line. */
const TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/][^<>\n]*)?(?:>|$)/gm;
const UNSAFE_SCHEME = /^\s*(?:javascript|vbscript|data)\s*:/i;
const INLINE_LINK_TARGET = /(\]\(\s*<?)([^)\s>]*)/g;
const REFERENCE_DEFINITION = /^( {0,3}\[[^\]]+\]:\s*<?)(\S+?)(>?)(?=\s|$)/gm;
const PLACEHOLDER = '\u0000BSAFE';

function sanitizeProse(text: string): string {
  const kept: string[] = [];
  const keep = (value: string) => {
    kept.push(value);
    return `${PLACEHOLDER}${kept.length - 1}\u0000`;
  };
  let out = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (match) => keep(match));
  out = out.replace(SAFE_AUTOLINK, (match) => keep(match));
  out = out
    .replace(DANGEROUS_BODY, '')
    .replace(COMMENT, '')
    .replace(TAG, '');
  out = out.replace(INLINE_LINK_TARGET, (match, open: string, target: string) => (
    UNSAFE_SCHEME.test(decodeEntities(target)) ? `${open}#` : match
  ));
  out = out.replace(REFERENCE_DEFINITION, (match, open: string, target: string, close: string) => (
    UNSAFE_SCHEME.test(decodeEntities(target)) ? `${open}#${close}` : match
  ));
  return out.replace(new RegExp(`${PLACEHOLDER}(\\d+)\u0000`, 'g'), (_m, index: string) => kept[Number(index)] ?? '');
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&colon;/gi, ':')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\s]+/g, '');
}

export function sanitizeBrainstormMarkdown(markdown: string): string {
  const lines = markdown.split(/(?<=\n)/);
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  const flushProse = () => {
    if (prose.length > 0) out.push(sanitizeProse(prose.join('')));
    prose = [];
  };

  for (const line of lines) {
    if (fence) {
      out.push(line);
      const close = line.match(FENCE_CLOSE);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      flushProse();
      fence = { marker: open[2][0], length: open[2].length };
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return out.join('');
}
