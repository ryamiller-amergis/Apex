/**
 * Targeted backlog edits: the model sees the backlog as `path = value` lines and
 * replies with only the edits, which are applied here to a copy of the backlog.
 */

export type BacklogEdit =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'remove'; path: string };

type PathSegment = string | number;

const VALID_PATH = /^(?:[^.[\]]+|\[\d+\])(?:\.[^.[\]]+|\[\d+\])*$/;
const PATH_SEGMENT = /([^.[\]]+)|\[(\d+)\]/g;

function parsePath(path: string): PathSegment[] | null {
  if (!VALID_PATH.test(path)) return null;
  return [...path.matchAll(PATH_SEGMENT)].map((match) =>
    match[2] !== undefined ? Number(match[2]) : match[1],
  );
}

function formatPath(segments: PathSegment[]): string {
  return segments
    .map((segment, index) =>
      typeof segment === 'number' ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join('');
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

/** Renders every leaf of a JSON value as `path = <json value>`, one per line. */
export function flattenBacklogForPrompt(backlog: unknown): string {
  const lines: string[] = [];
  const walk = (value: unknown, segments: PathSegment[]) => {
    if (isContainer(value)) {
      const entries: [PathSegment, unknown][] = Array.isArray(value)
        ? value.map((item, index) => [index, item])
        : Object.entries(value);
      if (entries.length === 0) {
        lines.push(`${formatPath(segments)} = ${Array.isArray(value) ? '[]' : '{}'}`);
        return;
      }
      for (const [key, child] of entries) walk(child, [...segments, key]);
      return;
    }
    lines.push(`${formatPath(segments)} = ${JSON.stringify(value)}`);
  };
  walk(backlog, []);
  return lines.join('\n');
}

/** Reads `{ "edits": [...] }` from a parsed model reply. Returns null when the shape is wrong. */
export function readBacklogEdits(reply: unknown): BacklogEdit[] | null {
  if (!isContainer(reply) || Array.isArray(reply) || !Array.isArray(reply.edits)) return null;
  const edits: BacklogEdit[] = [];
  for (const raw of reply.edits) {
    if (!isContainer(raw) || Array.isArray(raw) || typeof raw.path !== 'string') return null;
    if (raw.op === 'remove') {
      edits.push({ op: 'remove', path: raw.path });
    } else if ((raw.op === 'set' || raw.op === undefined) && 'value' in raw) {
      edits.push({ op: 'set', path: raw.path, value: raw.value });
    } else {
      return null;
    }
  }
  return edits;
}

function resolveParent(
  root: unknown,
  segments: PathSegment[],
): { parent: Record<string, unknown> | unknown[]; key: PathSegment } | null {
  let node: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isContainer(node)) return null;
    if (Array.isArray(node) !== (typeof segment === 'number')) return null;
    node = (node as Record<PathSegment, unknown>)[segment];
  }
  const key = segments[segments.length - 1];
  if (!isContainer(node) || Array.isArray(node) !== (typeof key === 'number')) return null;
  return { parent: node, key };
}

/**
 * Applies edits to a deep copy of the backlog. `set` may replace an existing
 * value or append to an array at index === length; `remove` deletes an existing
 * array item or key. Returns null if any edit targets a path that does not exist,
 * so a proposal never holds a partial fix.
 */
export function applyBacklogEdits(backlog: unknown, edits: BacklogEdit[]): unknown | null {
  if (edits.length === 0) return null;
  const copy: unknown = structuredClone(backlog);
  const removals: { parent: Record<string, unknown> | unknown[]; key: PathSegment }[] = [];
  const removedPaths = new Set<string>();

  for (const edit of edits) {
    if (edit.op === 'remove') {
      if (removedPaths.has(edit.path)) return null;
      removedPaths.add(edit.path);
    }
    const segments = parsePath(edit.path);
    if (!segments) return null;
    const target = resolveParent(copy, segments);
    if (!target) return null;
    const { parent, key } = target;

    if (Array.isArray(parent)) {
      const index = key as number;
      const appending = edit.op === 'set' && index === parent.length;
      if (!appending && index >= parent.length) return null;
    } else if (!Object.prototype.hasOwnProperty.call(parent, key)) {
      return null;
    }

    if (edit.op === 'set') {
      (parent as Record<PathSegment, unknown>)[key] = structuredClone(edit.value);
    } else {
      removals.push(target);
    }
  }

  // Remove highest indices first so earlier removals do not shift later ones.
  removals
    .sort((a, b) => (typeof a.key === 'number' && typeof b.key === 'number' ? b.key - a.key : 0))
    .forEach(({ parent, key }) => {
      if (Array.isArray(parent)) parent.splice(key as number, 1);
      else delete parent[key as string];
    });

  return copy;
}
