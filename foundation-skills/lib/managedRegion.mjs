/**
 * Three-zone SKILL.md layout for consumer repos:
 *
 *   ---
 *   frontmatter (from foundation)
 *   ---
 *
 *   <!-- APEX:BEGIN managed (skill @ version) -->
 *   … foundation body ONLY (no slots / no TODOs) …
 *   <!-- APEX:END managed -->
 *
 *   <!-- APEX:BEGIN adapter (skill @ version) -->
 *   … project-owned adapter scaffold with optional APEX:slot anchors …
 *   <!-- APEX:END adapter -->
 *
 *   ## Project notes
 *   … team-owned; never overwritten …
 *
 * Rules:
 *   - install/update replace foundation frontmatter + managed body
 *   - install/update never rewrite the adapter zone or project notes
 *   - explicit bootstrap/--fill may fill unfilled APEX:slot values in place
 */
import { normalizeText, sha256 } from './util.mjs';

export const END_MARKER = '<!-- APEX:END managed -->';
export const ADAPTER_END_MARKER = '<!-- APEX:END adapter -->';

const BEGIN_MANAGED_RE = /<!--\s*APEX:BEGIN\s+managed(?:\s*\([^)]*\))?\s*-->/;
const END_MANAGED_RE = /<!--\s*APEX:END\s+managed\s*-->/;
const BEGIN_ADAPTER_RE = /<!--\s*APEX:BEGIN\s+adapter(?:\s*\([^)]*\))?\s*-->/;
const END_ADAPTER_RE = /<!--\s*APEX:END\s+adapter\s*-->/;

/**
 * Compose a full three-zone SKILL.md.
 * Frontmatter comes from the foundation when present, else the adapter.
 */
export function compose(foundationText, adapterText, skill, version) {
  const { frontmatter: fFm, body: fBody } = splitFrontmatter(normalizeText(foundationText ?? ''));
  const { frontmatter: aFm, body: aBody } = splitFrontmatter(normalizeText(adapterText ?? ''));
  const frontmatter = fFm || aFm || defaultFrontmatter(skill);

  const managed = composeFoundationRegion(fBody, skill, version);
  const adapter = composeAdapterRegion(aBody, skill, version);
  const project = composeProjectStub();

  return normalizeText(`${frontmatter}\n${managed}${adapter}${project}`);
}

/** Foundation-only managed region (includes BEGIN/END managed markers). */
export function composeFoundationRegion(foundationBody, skill, version) {
  const begin = `<!-- APEX:BEGIN managed (${skill} @ ${version}) -->`;
  const notice =
    '<!-- DO NOT EDIT — APEX foundation. Replaced on install/update.\n' +
    '     Everything below APEX:END managed is project-owned. -->';
  const body = stripLeadingBlank(foundationBody);
  return normalizeText(`${begin}\n${notice}\n\n${body}${body.endsWith('\n') ? '' : '\n'}${END_MARKER}\n`);
}

/** Adapter zone (includes BEGIN/END adapter markers). */
export function composeAdapterRegion(adapterBody, skill, version) {
  const begin = `<!-- APEX:BEGIN adapter (${skill} @ ${version}) -->`;
  const notice =
    '<!-- Project-owned APEX adapter scaffold.\n' +
    '     Standard install/update never replace this content or its free-form edits.\n' +
    '     Bootstrap/--fill only fill explicitly unfilled APEX:slot(name) anchors. -->';
  const body = stripLeadingBlank(adapterBody);
  return normalizeText(
    `\n${begin}\n${notice}\n\n${body}${body.endsWith('\n') ? '' : '\n'}${ADAPTER_END_MARKER}\n`,
  );
}

export function composeProjectStub() {
  return (
    '\n## Project notes\n\n' +
    '<!-- Yours. APEX never writes below this line. -->\n'
  );
}

/**
 * Split a SKILL.md into zones.
 * @returns {{
 *   prefix: string,      // frontmatter (+ anything before managed BEGIN)
 *   managed: string,     // foundation zone including END managed
 *   adapter: string,     // adapter zone including END adapter (may be '')
 *   project: string,     // everything after adapter end (or after managed end if no adapter zone)
 *   hasFence: boolean,
 *   hasAdapterFence: boolean,
 * }}
 */
export function splitZones(fileText) {
  const text = normalizeText(fileText ?? '');
  const fenceStatus = inspectFences(text);
  if (!fenceStatus.hasFence) {
    return {
      prefix: '',
      managed: text,
      adapter: '',
      project: '',
      hasFence: false,
      hasAdapterFence: false,
      malformed: fenceStatus.malformed,
    };
  }
  const managedEnd = matchEnd(text, END_MANAGED_RE);
  if (!managedEnd) throw new Error('Validated managed fence end was not found');

  const prefix = text.slice(0, managedEnd.start);
  // Find BEGIN managed within prefix+managed for a clean managed slice:
  // managed = from BEGIN managed (or start of file after fm) through END managed
  const beginManaged = BEGIN_MANAGED_RE.exec(text);
  const managedStart = beginManaged ? beginManaged.index : 0;
  const managed = text.slice(managedStart, managedEnd.end);
  const afterManaged = text.slice(managedEnd.end);

  const adapterEnd = fenceStatus.hasAdapterFence
    ? matchEnd(afterManaged, END_ADAPTER_RE)
    : null;
  if (!adapterEnd) {
    // Legacy single-fence layout: everything after managed END is "project"
    // (may still contain old combined adapter content — callers upgrade on write).
    return {
      prefix: text.slice(0, managedStart),
      managed,
      adapter: '',
      project: afterManaged,
      hasFence: true,
      hasAdapterFence: false,
      malformed: false,
    };
  }

  const adapter = afterManaged.slice(0, adapterEnd.end);
  const project = afterManaged.slice(adapterEnd.end);
  return {
    prefix: text.slice(0, managedStart),
    managed,
    adapter,
    project,
    hasFence: true,
    hasAdapterFence: true,
    malformed: false,
  };
}

/** Back-compat split: managed (+ prefix) vs rest. */
export function split(fileText) {
  const z = splitZones(fileText);
  if (!z.hasFence) {
    return { managed: z.managed, project: '', hasFence: false };
  }
  return {
    managed: z.prefix + z.managed,
    project: z.adapter + z.project,
    hasFence: true,
  };
}

/**
 * Replace the foundation managed zone, preserving adapter + project notes.
 * Upgrades legacy single-fence files by keeping the old tail as project notes
 * when no adapter zone exists (caller should normally also spliceAdapter).
 */
export function spliceFoundation(fileText, newManagedRegion) {
  const z = splitZones(fileText);
  if (!z.hasFence) return null;
  const incoming = splitZones(newManagedRegion);
  if (incoming.hasFence) {
    const prefix = incoming.prefix.trim() ? incoming.prefix : z.prefix;
    return normalizeText(prefix + incoming.managed + z.adapter + z.project);
  }

  const managed = ensureTrailingNl(normalizeText(newManagedRegion));
  return normalizeText(z.prefix + stripLeadingFrontmatter(managed) + z.adapter + z.project);
}

/**
 * Replace (or insert) the adapter zone, preserving foundation + project notes.
 * If the file has a managed fence but no adapter fence (legacy), inserts the
 * adapter zone between managed END and the project tail.
 */
export function spliceAdapter(fileText, newAdapterRegion) {
  const z = splitZones(fileText);
  if (!z.hasFence) return null;
  const adapter = ensureTrailingNl(normalizeText(newAdapterRegion));
  // Ensure adapter region starts with a newline separation
  const adapterBlock = adapter.startsWith('\n') ? adapter : `\n${adapter}`;

  if (z.hasAdapterFence) {
    return normalizeText(z.prefix + z.managed + adapterBlock + z.project);
  }

  // Legacy: project may include old combined content. Keep it as project notes.
  const project = z.project.includes('## Project notes')
    ? z.project
    : composeProjectStub() + (z.project ? `\n${stripLeadingBlank(z.project)}` : '');
  return normalizeText(z.prefix + z.managed + adapterBlock + project);
}

/**
 * Full rewrite of managed + adapter, preserving project notes when possible.
 */
export function splice(fileText, newManagedRegion, newAdapterRegion = null) {
  const z = splitZones(fileText);
  if (!z.hasFence) return null;
  let next = spliceFoundation(fileText, newManagedRegion);
  if (newAdapterRegion != null) {
    next = spliceAdapter(next, newAdapterRegion);
  }
  return next;
}

/** Hash of foundation-owned frontmatter + managed zone (null if no fence). */
export function hashManaged(fileText) {
  const z = splitZones(fileText);
  if (!z.hasFence) return null;
  return sha256(normalizeText(z.prefix + z.managed));
}

/** Hash of the adapter zone (null if missing). */
export function hashAdapter(fileText) {
  const z = splitZones(fileText);
  if (!z.hasAdapterFence) return null;
  return sha256(normalizeText(z.adapter));
}

/**
 * Build foundation managed region text from foundation SKILL.md source.
 * (No adapter content.)
 */
export function composeManaged(foundationText, _adapterTextIgnored, skill, version) {
  const { frontmatter, body } = splitFrontmatter(normalizeText(foundationText ?? ''));
  const ownedFrontmatter = frontmatter || defaultFrontmatter(skill);
  return normalizeText(
    `${ownedFrontmatter}\n${composeFoundationRegion(body, skill, version)}`,
  );
}

/** Build adapter region from rendered adapter SKILL.md source. */
export function composeAdapter(adapterText, skill, version) {
  const { body } = splitFrontmatter(normalizeText(adapterText ?? ''));
  return composeAdapterRegion(body, skill, version);
}

export function hasFence(fileText) {
  return inspectFences(fileText).hasFence;
}

export function hasAdapterFence(fileText) {
  return inspectFences(fileText).hasAdapterFence;
}

export function hasBeginFence(fileText) {
  return inspectFences(fileText).hasFence;
}

export function inspectFences(fileText) {
  const text = normalizeText(fileText ?? '');
  const managedBegins = matches(text, BEGIN_MANAGED_RE);
  const managedEnds = matches(text, END_MANAGED_RE);
  const adapterBegins = matches(text, BEGIN_ADAPTER_RE);
  const adapterEnds = matches(text, END_ADAPTER_RE);
  const hasAnyManaged = managedBegins.length > 0 || managedEnds.length > 0;
  const hasAnyAdapter = adapterBegins.length > 0 || adapterEnds.length > 0;

  if (!hasAnyManaged && !hasAnyAdapter) {
    return {
      hasFence: false,
      hasAdapterFence: false,
      malformed: false,
      reason: null,
    };
  }
  if (
    managedBegins.length !== 1 ||
    managedEnds.length !== 1 ||
    managedBegins[0].index >= managedEnds[0].index
  ) {
    return {
      hasFence: false,
      hasAdapterFence: false,
      malformed: true,
      reason: 'managed fence requires exactly one ordered begin/end pair',
    };
  }
  if (
    hasAnyAdapter &&
    (
      adapterBegins.length !== 1 ||
      adapterEnds.length !== 1 ||
      adapterBegins[0].index <= managedEnds[0].index ||
      adapterBegins[0].index >= adapterEnds[0].index
    )
  ) {
    return {
      hasFence: false,
      hasAdapterFence: false,
      malformed: true,
      reason: 'adapter fence requires exactly one ordered pair after managed content',
    };
  }
  return {
    hasFence: true,
    hasAdapterFence: hasAnyAdapter,
    malformed: false,
    reason: null,
  };
}

function matchEnd(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  let end = m.index + m[0].length;
  if (text[end] === '\n') end += 1;
  return { start: m.index, end };
}

function matches(text, re) {
  const global = new RegExp(re.source, 'g');
  return [...text.matchAll(global)];
}

function ensureTrailingNl(t) {
  return t.endsWith('\n') ? t : `${t}\n`;
}

function splitFrontmatter(text) {
  const t = normalizeText(text);
  if (!t.startsWith('---\n')) {
    return { frontmatter: '', body: stripLeadingBlank(t) };
  }
  const end = t.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: '', body: stripLeadingBlank(t) };
  }
  const fm = t.slice(0, end + '\n---\n'.length);
  const body = stripLeadingBlank(t.slice(end + '\n---\n'.length));
  return { frontmatter: fm.trimEnd(), body };
}

/** If a region accidentally includes frontmatter, drop it. */
function stripLeadingFrontmatter(text) {
  const t = normalizeText(text);
  if (!t.startsWith('---\n')) return t;
  const { body } = splitFrontmatter(t);
  // If the "body" still has BEGIN managed, the fm was accidental
  if (BEGIN_MANAGED_RE.test(body) || END_MANAGED_RE.test(body)) {
    return ensureTrailingNl(body.startsWith('<!--') ? body : t);
  }
  return t;
}

function stripLeadingBlank(t) {
  return (t ?? '').replace(/^\n+/, '');
}

function defaultFrontmatter(skill) {
  return `---\nname: ${skill}\ndescription: APEX skill — foundation above the fence; project notes below.\n---`;
}
