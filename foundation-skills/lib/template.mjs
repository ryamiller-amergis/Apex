/**
 * Stage B: deterministic slot templating.
 *
 * An adapter template is text containing slot markers:
 *   {{slot:slotName}}
 *
 * The recipe maps each slotName to a rendering directive resolved ONLY from the
 * evidence index. A slot with no backing evidence renders a labeled TODO. This
 * makes "no invented facts" and "only references paths that exist" structural.
 *
 * Slot directive shapes (recipe.slots[slotName]):
 *   { type: "list",  detector: "components", limit?, format?: "- {value}" }
 *   { type: "table", detector: "css-variables", columns: ["key","value"], limit? }
 *   { type: "value", detector: "stack", key: "projectName" }
 *   { type: "count", detector: "routes" }
 */

const SLOT_RE = /\{\{slot:([a-zA-Z0-9_-]+)\}\}/g;

export function renderTemplate(templateText, recipe, evidenceIndex) {
  const explain = {}; // slotName -> { filled, evidence: [{value, source}] , todo }
  const slots = recipe.slots ?? {};

  const output = templateText.replace(SLOT_RE, (_, slotName) => {
    const directive = slots[slotName];
    if (!directive) {
      explain[slotName] = { filled: false, todo: true, reason: 'no directive' };
      return todo(slotName, 'no recipe directive');
    }
    const rendered = renderSlot(slotName, directive, evidenceIndex, explain);
    return rendered;
  });

  return { text: output, explain };
}

function renderSlot(slotName, directive, idx, explain) {
  const bucket = idx[directive.detector] ?? {};
  const all = Object.values(bucket);

  const record = (filled, evidence, extra = {}) => {
    explain[slotName] = { filled, todo: !filled, detector: directive.detector, evidence, ...extra };
  };

  switch (directive.type) {
    case 'value': {
      const e = bucket[directive.key];
      if (!e) {
        record(false, []);
        return todo(slotName, `no ${directive.detector}.${directive.key} found`);
      }
      record(true, [ev(e)]);
      return String(e.value);
    }
    case 'count': {
      record(true, all.map(ev));
      return String(all.length);
    }
    case 'list': {
      const items = limitList(all, directive.limit);
      if (items.length === 0) {
        record(false, []);
        return todo(slotName, `no ${directive.detector} evidence`);
      }
      const fmt = directive.format ?? '- {value}';
      record(true, items.map(ev));
      return items.map((e) => fmt.replace('{key}', e.key).replace('{value}', String(e.value))).join('\n');
    }
    case 'table': {
      const items = limitList(all, directive.limit);
      if (items.length === 0) {
        record(false, []);
        return todo(slotName, `no ${directive.detector} evidence`);
      }
      const cols = directive.columns ?? ['key', 'value'];
      const header = `| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |`;
      const rows = items.map((e) => `| ${cols.map((c) => String(e[c] ?? '')).join(' | ')} |`);
      record(true, items.map(ev));
      return [header, ...rows].join('\n');
    }
    default:
      explain[slotName] = { filled: false, todo: true, reason: `unknown type ${directive.type}` };
      return todo(slotName, `unknown directive type "${directive.type}"`);
  }
}

function limitList(arr, limit) {
  const sorted = [...arr].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
}

function ev(e) {
  return { value: e.value, key: e.key, source: e.source };
}

function todo(slotName, reason) {
  return `<!-- TODO(${slotName}): ${reason} — fill in manually -->`;
}

/** True if any slot in the render is an unfilled TODO. */
export function hasTodos(explain) {
  return Object.values(explain).some((s) => s.todo);
}
