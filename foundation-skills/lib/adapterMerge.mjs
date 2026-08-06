/**
 * Fill project-owned APEX adapter slots without replacing the surrounding
 * adapter prose, ordering, or free-form team edits.
 *
 * Slot anchors (emitted by template.mjs):
 *   <!-- APEX:slot(name) -->
 *   … value or APEX:unfilled(name) …
 *   <!-- APEX:/slot(name) -->
 *
 * Filled values from the existing adapter win. Still-unfilled slots take the
 * incoming detector result. New slots are appended only when the existing
 * adapter already uses slot anchors; a plain hand-written adapter is untouched.
 */
import { normalizeText } from './util.mjs';
import { composeAdapterRegion } from './managedRegion.mjs';

const SLOT_BLOCK_RE =
  /<!--\s*APEX:slot\(([a-zA-Z0-9_-]+)\)\s*-->\n?([\s\S]*?)<!--\s*APEX:\/slot\(\1\)\s*-->/g;

const FILLED_BLOCK_RE =
  /<!--\s*APEX:filled\(([a-zA-Z0-9_-]+)\)\s*-->\n?([\s\S]*?)<!--\s*APEX:\/filled\(\1\)\s*-->/g;

const UNFILLED_RE = /<!--\s*APEX:unfilled\(([a-zA-Z0-9_-]+)\):[\s\S]*?-->/;
const ADAPTER_END_RE = /<!--\s*APEX:END\s+adapter\s*-->/;

export function wrapSlot(slotName, inner) {
  const body = String(inner ?? '').replace(/^\n+|\n+$/g, '');
  return `<!-- APEX:slot(${slotName}) -->\n${body}\n<!-- APEX:/slot(${slotName}) -->`;
}

export function isUnfilledInner(inner) {
  const t = String(inner ?? '');
  return UNFILLED_RE.test(t) || /<!--\s*TODO\([a-zA-Z0-9_-]+\):/.test(t);
}

/** @returns {Map<string, { value: string, isUnfilled: boolean }>} */
export function extractSlotValues(adapterBody) {
  const map = new Map();
  const text = normalizeText(adapterBody ?? '');

  for (const re of [SLOT_BLOCK_RE, FILLED_BLOCK_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const value = m[2].replace(/^\n+|\n+$/g, '');
      // Prefer the first non-unfilled value if a slot appears twice.
      const prev = map.get(name);
      if (prev && !prev.isUnfilled) continue;
      map.set(name, { value, isUnfilled: isUnfilledInner(value) });
    }
  }

  return map;
}

/** Replace one slot block's inner content; no-op if the slot is absent. */
export function replaceSlotInner(adapterBody, slotName, newInner) {
  const text = normalizeText(adapterBody ?? '');
  const re = new RegExp(
    `<!--\\s*APEX:slot\\(${escapeRegExp(slotName)}\\)\\s*-->\\n?[\\s\\S]*?<!--\\s*APEX:\\/slot\\(${escapeRegExp(slotName)}\\)\\s*-->`,
  );
  if (!re.test(text)) return text;
  return text.replace(re, () => wrapSlot(slotName, newInner));
}

/**
 * Fill anchored gaps in a project-owned adapter body.
 */
export function mergeAdapterBodies(existingBody, incomingBody) {
  const existing = normalizeText(existingBody ?? '');
  const incoming = normalizeText(incomingBody ?? '');
  const existingFills = extractSlotValues(existingBody);

  if (!existingFills.size) {
    return existing;
  }

  let result = existing;
  const incomingSlots = extractSlotValues(incoming);

  for (const [name, prev] of existingFills) {
    const next = incomingSlots.get(name);
    if (prev.isUnfilled && next && !next.isUnfilled) {
      result = replaceSlotInner(result, name, next.value);
    }
  }

  for (const [name, next] of incomingSlots) {
    if (existingFills.has(name)) continue;
    result = `${result.trimEnd()}\n\n${wrapSlot(name, next.value)}\n`;
  }

  return result;
}

/**
 * Build a full adapter region (with BEGIN/END markers) by merging the existing
 * file's adapter body with a newly composed incoming adapter region.
 */
export function mergeAdapterRegions(existingFileText, incomingAdapterRegion, skill, version) {
  const existingRegion = extractAdapterRegionFromFile(existingFileText);
  if (!existingRegion) {
    return composeAdapterRegion(
      extractAdapterBodyFromRegion(incomingAdapterRegion),
      skill,
      version,
    );
  }

  const incomingBody = extractAdapterBodyFromRegion(incomingAdapterRegion);
  const existingSlots = extractSlotValues(existingRegion);
  if (!existingSlots.size) return existingRegion;

  const incomingSlots = extractSlotValues(incomingBody);
  let result = existingRegion;

  for (const [name, current] of existingSlots) {
    const incoming = incomingSlots.get(name);
    if (current.isUnfilled && incoming && !incoming.isUnfilled) {
      result = replaceSlotInner(result, name, incoming.value);
    }
  }

  for (const [name, incoming] of incomingSlots) {
    if (existingSlots.has(name)) continue;
    const end = ADAPTER_END_RE.exec(result);
    if (!end) break;
    const insertion = `${wrapSlot(name, incoming.value)}\n`;
    result = `${result.slice(0, end.index)}${insertion}${result.slice(end.index)}`;
  }

  return normalizeText(result);
}

/** Strip BEGIN/END + notice from an adapter region → body only. */
export function extractAdapterBodyFromRegion(adapterRegion) {
  const t = normalizeText(adapterRegion ?? '');
  const begin = /<!--\s*APEX:BEGIN\s+adapter[^>]*-->/.exec(t);
  const end = /<!--\s*APEX:END\s+adapter\s*-->/.exec(t);
  if (begin && end) {
    let body = t.slice(begin.index + begin[0].length, end.index);
    return stripAdapterNotice(body);
  }
  return stripLeadingBlank(t);
}

function extractAdapterRegionFromFile(fileText) {
  const t = normalizeText(fileText ?? '');
  const begin = /<!--\s*APEX:BEGIN\s+adapter[^>]*-->/.exec(t);
  const end = /<!--\s*APEX:END\s+adapter\s*-->/.exec(t);
  if (begin && end) {
    let endIdx = end.index + end[0].length;
    if (t[endIdx] === '\n') endIdx += 1;
    return t.slice(begin.index, endIdx);
  }
  return '';
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLeadingBlank(t) {
  return (t ?? '').replace(/^\n+/, '');
}

function stripAdapterNotice(body) {
  const text = stripLeadingBlank(body);
  const knownNotice =
    text.startsWith('<!-- APEX project context —') ||
    text.startsWith('<!-- Project-owned APEX adapter scaffold.');
  if (!knownNotice) return text;

  const lines = text.split('\n');
  const end = lines.findIndex((line) => line.trimEnd().endsWith('-->'));
  if (end === -1) return text;
  return stripLeadingBlank(lines.slice(end + 1).join('\n'));
}

/** List bare or nested unfilled markers (for skills / diagnostics). */
export function listUnfilledMarkers(text) {
  const t = normalizeText(text ?? '');
  const out = [];
  const re = /<!--\s*APEX:unfilled\(([a-zA-Z0-9_-]+)\):\s*([\s\S]*?)\s*-->/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    out.push({ slot: m[1], reason: m[2].trim(), raw: m[0] });
  }
  const legacy = /<!--\s*TODO\(([a-zA-Z0-9_-]+)\):\s*([\s\S]*?)\s*-->/g;
  while ((m = legacy.exec(t)) !== null) {
    out.push({ slot: m[1], reason: m[2].trim(), raw: m[0], legacy: true });
  }
  return out;
}
