import type { ChatMessage } from '../../shared/types/chat';

export type ChecklistItemStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistItemStatus;
}

/**
 * Where the checklist came from:
 *   - todo_tool: the agent's todo tool output (driven by the project's dev skill)
 *   - markdown:  markdown checkboxes in the latest agent message
 *   - none:      no phase data yet — the checklist is hidden
 */
export type ChecklistSource = 'todo_tool' | 'markdown' | 'none';

export interface AgentChecklist {
  items: ChecklistItem[];
  source: ChecklistSource;
}

// ── Tier 1: Cursor agent todo tool message ─────────────────────────────────
// The phases themselves are defined by the project's development skill, which
// instructs the agent to emit a todo list at the start of the session. We never
// hardcode phase labels here — we render whatever the skill/agent produced.

function tryParseTodoTool(messages: ChatMessage[]): ChecklistItem[] | null {
  const todoMsgs = messages.filter(
    (m) => m.role === 'tool' && m.toolName && /todo/i.test(m.toolName),
  );
  if (todoMsgs.length === 0) return null;

  const latest = todoMsgs[todoMsgs.length - 1];
  const input = latest.toolInput as Record<string, unknown> | undefined;
  if (!input) return null;

  // Try several known input shapes that Cursor SDK agents emit
  const rawList =
    (Array.isArray(input.todos) && input.todos) ||
    (Array.isArray(input.tasks) && input.tasks) ||
    (Array.isArray(input.items) && input.items) ||
    null;

  if (!rawList || rawList.length === 0) return null;

  return (rawList as Record<string, unknown>[])
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item, i) => {
      const label =
        (typeof item.content === 'string' ? item.content : null) ??
        (typeof item.title === 'string' ? item.title : null) ??
        (typeof item.label === 'string' ? item.label : null) ??
        `Task ${i + 1}`;

      const rawStatus = typeof item.status === 'string' ? item.status.toLowerCase() : '';
      let status: ChecklistItemStatus = 'pending';
      if (rawStatus === 'completed' || rawStatus === 'done' || rawStatus === 'finished') {
        status = 'completed';
      } else if (rawStatus === 'in_progress' || rawStatus === 'active' || rawStatus === 'working') {
        status = 'in_progress';
      } else if (rawStatus === 'cancelled' || rawStatus === 'canceled' || rawStatus === 'skipped') {
        status = 'cancelled';
      }

      return { id: `todo-${i}`, label, status };
    });
}

// ── Tier 2: Markdown checkboxes in the latest agent text message ───────────

const CHECKBOX_RE = /^\s*[-*]\s+\[([ xXvV✓])\]\s+(.+)$/;

function tryParseMarkdownCheckboxes(messages: ChatMessage[]): ChecklistItem[] | null {
  const agentTextMsgs = messages.filter(
    (m) => m.role === 'agent' && !m.toolName && m.text.trim().length > 0,
  );
  if (agentTextMsgs.length === 0) return null;

  const latest = agentTextMsgs[agentTextMsgs.length - 1];
  const items: ChecklistItem[] = [];

  for (const line of latest.text.split('\n')) {
    const match = line.match(CHECKBOX_RE);
    if (!match) continue;
    const checked = match[1].trim() !== '';
    items.push({
      id: `md-${items.length}`,
      label: match[2].trim(),
      status: checked ? 'completed' : 'pending',
    });
  }

  return items.length > 0 ? items : null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Builds the dev-session checklist from real agent output only. Phase labels are
 * never hardcoded — they come from the project's development skill via the
 * agent's todo tool (or, secondarily, markdown checkboxes). When the agent has
 * not yet produced any phase data, the checklist is empty and the panel hides.
 */
export function parseAgentTodos(messages: ChatMessage[]): AgentChecklist {
  const todoItems = tryParseTodoTool(messages);
  if (todoItems && todoItems.length > 0) {
    return { items: todoItems, source: 'todo_tool' };
  }

  const mdItems = tryParseMarkdownCheckboxes(messages);
  if (mdItems && mdItems.length > 0) {
    return { items: mdItems, source: 'markdown' };
  }

  return { items: [], source: 'none' };
}
