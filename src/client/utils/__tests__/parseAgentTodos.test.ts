import { parseAgentTodos } from '../parseAgentTodos';
import type { ChatMessage } from '../../../shared/types/chat';

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    role: partial.role,
    text: partial.text ?? '',
    ts: partial.ts ?? new Date().toISOString(),
    toolName: partial.toolName,
    toolInput: partial.toolInput,
  };
}

describe('parseAgentTodos', () => {
  it('renders phases from the agent todo tool (project-skill driven)', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', text: 'Begin.' }),
      msg({
        role: 'tool',
        toolName: 'todo_write',
        toolInput: {
          todos: [
            { content: 'Plan', status: 'completed' },
            { content: 'Code', status: 'in_progress' },
            { content: 'Review', status: 'pending' },
            { content: 'Handoff', status: 'pending' },
          ],
        },
      }),
    ];

    const result = parseAgentTodos(messages);

    expect(result.source).toBe('todo_tool');
    expect(result.items.map((i) => i.label)).toEqual(['Plan', 'Code', 'Review', 'Handoff']);
    expect(result.items.map((i) => i.status)).toEqual([
      'completed',
      'in_progress',
      'pending',
      'pending',
    ]);
  });

  it('uses the latest todo tool message so status updates are reflected', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'tool', toolName: 'todo_write', toolInput: { todos: [{ content: 'Plan', status: 'in_progress' }] } }),
      msg({ role: 'tool', toolName: 'todo_write', toolInput: { todos: [{ content: 'Plan', status: 'completed' }] } }),
    ];

    const result = parseAgentTodos(messages);

    expect(result.items[0].status).toBe('completed');
  });

  it('falls back to markdown checkboxes when no todo tool is present', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'agent', text: '- [x] Plan\n- [ ] Code\n- [ ] Review' }),
    ];

    const result = parseAgentTodos(messages);

    expect(result.source).toBe('markdown');
    expect(result.items.map((i) => i.status)).toEqual(['completed', 'pending', 'pending']);
  });

  it('returns an empty checklist (hidden) when there is no phase data yet', () => {
    const messages: ChatMessage[] = [
      msg({ role: 'user', text: 'Begin.' }),
      msg({ role: 'tool', toolName: '_reasoning', text: 'thinking about the task' }),
    ];

    const result = parseAgentTodos(messages);

    expect(result.source).toBe('none');
    expect(result.items).toHaveLength(0);
  });
});
