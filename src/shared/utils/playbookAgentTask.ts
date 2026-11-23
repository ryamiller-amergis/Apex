/**
 * An Agent task is one step type. Its Skill decides how it runs: an interactive Skill chats with
 * an assignee and waits for approval, any other Skill (or none) runs on its own.
 */

export type AgentTaskMode = 'autonomous' | 'interactive';

/**
 * What a suspended interactive Agent task keeps on its step row while the assignee chats.
 * An autonomous task parks with no inline output, so this shape tells the two apart.
 */
export function isInteractiveTaskDraft(
  value: unknown,
): value is { threadId: string; assigneeUserId: string } {
  if (!value || typeof value !== 'object') return false;
  const draft = value as { threadId?: unknown; assigneeUserId?: unknown };
  return typeof draft.threadId === 'string' && typeof draft.assigneeUserId === 'string';
}

/** The mode a declared skill type selects. A missing declaration runs on its own. */
export function agentTaskModeForSkillType(skillType: string | null | undefined): AgentTaskMode {
  return skillType === 'interactive' ? 'interactive' : 'autonomous';
}
