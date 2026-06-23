/**
 * Client-side utility: extracts color values from prototype HTML and matches
 * them against the MaxView design token catalog. Zero LLM tokens — purely
 * post-processing on the already-generated HTML.
 */

import tokenCatalog from '../../server/assets/maxview-colors.json';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DesignTokenMatch {
  /** The color value as it appears in the HTML (normalised to lowercase). */
  value: string;
  /** Matched token path, e.g. "primary.main". Null if off-palette. */
  token: string | null;
  /** Semantic usage hint from the catalog. */
  usage: string | null;
  /** Category group, e.g. "primary", "error", "ui". */
  group: string | null;
  /** How many times this color appears in the HTML. */
  count: number;
}

// ── Build a lookup map from the JSON catalog ───────────────────────────────

interface CatalogEntry {
  value: string;
  description?: string;
  usage?: string;
}

type CatalogGroup = Record<string, CatalogEntry>;

function normaliseColor(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

function buildTokenMap(): Map<string, { token: string; usage: string; group: string }> {
  const map = new Map<string, { token: string; usage: string; group: string }>();
  const catalog = tokenCatalog as Record<string, CatalogGroup | { $meta?: unknown }>;

  for (const [group, entries] of Object.entries(catalog)) {
    if (group === '$meta') continue;
    for (const [key, entry] of Object.entries(entries as CatalogGroup)) {
      const norm = normaliseColor(entry.value);
      const tokenPath = `${group}.${key}`;
      map.set(norm, {
        token: entry.description ?? tokenPath,
        usage: entry.usage ?? '',
        group,
      });
    }
  }
  return map;
}

const TOKEN_MAP = buildTokenMap();

// ── Extract colors from HTML ───────────────────────────────────────────────

const HEX_RE = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/g;
const RGBA_RE = /rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)/gi;

function extractRawColors(html: string): Map<string, number> {
  const counts = new Map<string, number>();

  const bump = (raw: string) => {
    const norm = normaliseColor(raw);
    if (norm === '#fff' || norm === '#ffffff' || norm === '#000' || norm === '#000000') return;
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
  };

  for (const m of html.matchAll(HEX_RE)) bump(m[0]);
  for (const m of html.matchAll(RGBA_RE)) bump(m[0]);
  return counts;
}

/**
 * Expand 3/4-char hex to 6/8-char for matching purposes.
 * e.g. #abc -> #aabbcc, #abcd -> #aabbccdd
 */
function expandShortHex(hex: string): string {
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  if (hex.length === 5) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}${hex[4]}${hex[4]}`;
  }
  return hex;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function auditPrototypeColors(html: string): DesignTokenMatch[] {
  const raw = extractRawColors(html);
  const results: DesignTokenMatch[] = [];

  for (const [norm, count] of raw) {
    const expanded = norm.startsWith('#') ? expandShortHex(norm) : norm;
    const match = TOKEN_MAP.get(norm) ?? TOKEN_MAP.get(expanded);

    results.push({
      value: norm,
      token: match?.token ?? null,
      usage: match?.usage ?? null,
      group: match?.group ?? null,
      count,
    });
  }

  results.sort((a, b) => {
    if (a.token && !b.token) return -1;
    if (!a.token && b.token) return 1;
    if (a.group && b.group && a.group !== b.group) return a.group.localeCompare(b.group);
    return b.count - a.count;
  });

  return results;
}
