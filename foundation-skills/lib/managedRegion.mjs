/**
 * Fenced managed region for adapter SKILL.md files.
 *
 * Layout after Option 3 merge:
 *
 *   ---
 *   frontmatter
 *   ---
 *
 *   <!-- APEX:BEGIN managed (skill @ version) -->
 *   ... foundation + rendered adapter body ...
 *   <!-- APEX:END managed -->
 *
 *   ## Project notes
 *   ... team-owned content below the END marker ...
 *
 * Boundary rule: everything ABOVE (and including) the END marker is managed;
 * everything BELOW is the project's and is never overwritten.
 */
import { normalizeText, sha256 } from './util.mjs';

export const BEGIN_PREFIX = '<!-- APEX:BEGIN managed';
export const END_MARKER = '<!-- APEX:END managed -->';

const BEGIN_RE = /<!--\s*APEX:BEGIN\s+managed(?:\s*\([^)]*\))?\s*-->/;
const END_RE = /<!--\s*APEX:END\s+managed\s*-->/;

/**
 * Compose a full SKILL.md from foundation + adapter template bodies.
 * Frontmatter is taken from the foundation when present, otherwise from the adapter.
 *
 * @param {string} foundationText
 * @param {string} adapterText
 * @param {string} skill
 * @param {string} version
 * @returns {string}
 */
export function compose(foundationText, adapterText, skill, version) {
  const foundation = normalizeText(foundationText ?? '');
  const adapter = normalizeText(adapterText ?? '');

  const { frontmatter: fFm, body: fBody } = splitFrontmatter(foundation);
  const { frontmatter: aFm, body: aBody } = splitFrontmatter(adapter);

  // Prefer foundation frontmatter (canonical skill name/description); fall back to adapter.
  const frontmatter = fFm || aFm || defaultFrontmatter(skill);
  const managedBody = joinBodies(fBody, aBody);

  const begin = `${BEGIN_PREFIX} (${skill} @ ${version}) -->`;
  const notice =
    '<!-- Everything above the END marker is replaced by APEX on update. Put project\n' +
    '     customization below it instead. -->';

  const managed =
    `${frontmatter}\n` +
    `${begin}\n` +
    `${notice}\n\n` +
    `${managedBody}` +
    `${END_MARKER}\n`;

  const project =
    '\n## Project notes\n\n' +
    '<!-- Yours. APEX never writes below this line. -->\n';

  return normalizeText(managed + project);
}

/**
 * Split a SKILL.md into managed (above/including END) and project (below END) parts.
 * @returns {{ managed: string, project: string, hasFence: boolean }}
 */
export function split(fileText) {
  const text = normalizeText(fileText ?? '');
  const endMatch = END_RE.exec(text);
  if (!endMatch) {
    return { managed: text, project: '', hasFence: false };
  }
  const endIdx = endMatch.index + endMatch[0].length;
  // Include the trailing newline after END if present so splice is clean.
  let managedEnd = endIdx;
  if (text[managedEnd] === '\n') managedEnd += 1;
  return {
    managed: text.slice(0, managedEnd),
    project: text.slice(managedEnd),
    hasFence: true,
  };
}

/**
 * Replace the managed region of an existing file, preserving the project tail.
 * If no fence is present, returns null (caller should skip or warn).
 *
 * @param {string} fileText existing file contents
 * @param {string} newManaged full managed region including END marker (+ trailing newline)
 * @returns {string|null}
 */
export function splice(fileText, newManaged) {
  const { project, hasFence } = split(fileText);
  if (!hasFence) return null;
  const managed = normalizeText(newManaged);
  // ensure managed ends with exactly one newline before project content
  const managedClean = managed.endsWith('\n') ? managed : `${managed}\n`;
  // project may start with leading newlines; keep as-is
  return normalizeText(managedClean + project);
}

/**
 * Hash of the managed region only (empty string if no fence).
 */
export function hashManaged(fileText) {
  const { managed, hasFence } = split(fileText);
  if (!hasFence) return null;
  return sha256(normalizeText(managed));
}

/**
 * Build only the managed region (no project stub) from foundation + adapter.
 * Used when splicing into an existing fenced file.
 */
export function composeManaged(foundationText, adapterText, skill, version) {
  const full = compose(foundationText, adapterText, skill, version);
  const { managed } = split(full);
  return managed;
}

/** True if the text contains a recognizable APEX END fence. */
export function hasFence(fileText) {
  return END_RE.test(normalizeText(fileText ?? ''));
}

/** True if BEGIN marker is also present (well-formed fence pair). */
export function hasBeginFence(fileText) {
  return BEGIN_RE.test(normalizeText(fileText ?? ''));
}

function splitFrontmatter(text) {
  const t = normalizeText(text);
  if (!t.startsWith('---\n')) {
    return { frontmatter: '', body: stripLeadingBlank(t) };
  }
  const end = t.indexOf('\n---\n', 4);
  if (end === -1) {
    // Malformed — treat whole thing as body
    return { frontmatter: '', body: stripLeadingBlank(t) };
  }
  const fm = t.slice(0, end + '\n---\n'.length);
  const body = stripLeadingBlank(t.slice(end + '\n---\n'.length));
  return { frontmatter: fm.trimEnd(), body };
}

function joinBodies(a, b) {
  const left = stripLeadingBlank(a);
  const right = stripLeadingBlank(b);
  if (!left) return right;
  if (!right) return left;
  return `${left}\n${right}`;
}

function stripLeadingBlank(t) {
  return (t ?? '').replace(/^\n+/, '');
}

function defaultFrontmatter(skill) {
  return `---\nname: ${skill}\ndescription: Project adapter for ${skill}. Customize below the managed fence.\n---`;
}
