/**
 * Seed chat harness area identifiers (FEAT-001 / TBI-004).
 * Extended in FEAT-002 (TBI-006) with command, receipt, state frame, and activity types.
 */

export const CHAT_AREA_IDS = [
  'agent-home',
  'interview',
  'adr',
  'prd-assistant',
  'design-doc-assistant',
  'ask-apex',
  'calendar-assistant',
  'qa-lab',
  'ui-lab',
  'brainstorm',
  'cab-release',
  'build-intake',
  'standup-participant',
] as const;

export type ChatAreaId = (typeof CHAT_AREA_IDS)[number];

export function isChatAreaId(value: unknown): value is ChatAreaId {
  return (
    typeof value === 'string'
    && (CHAT_AREA_IDS as readonly string[]).includes(value)
  );
}

const WORKFLOW_TO_CHAT_AREA: Readonly<Record<string, ChatAreaId>> = {
  'agent-home': 'agent-home',
  'home-chat': 'agent-home',
  agent_home_chat: 'agent-home',
  interview: 'interview',
  adr: 'adr',
  'prd-assistant': 'prd-assistant',
  prdAssistant: 'prd-assistant',
  'design-doc-assistant': 'design-doc-assistant',
  designDocAssistant: 'design-doc-assistant',
  'ask-apex': 'ask-apex',
  ask_apex: 'ask-apex',
  'calendar-assistant': 'calendar-assistant',
  'calendar-work-item': 'calendar-assistant',
  calendarAssistant: 'calendar-assistant',
  'qa-lab': 'qa-lab',
  'ui-lab': 'ui-lab',
  brainstorm: 'brainstorm',
  'cab-release': 'cab-release',
  'build-intake': 'build-intake',
  'standup-participant': 'standup-participant',
  standup: 'standup-participant',
};

export function resolveChatAreaId(
  workflowOrArea: string | null | undefined,
): ChatAreaId | null {
  if (!workflowOrArea) return null;
  const trimmed = workflowOrArea.trim();
  if (!trimmed) return null;
  if (isChatAreaId(trimmed)) return trimmed;
  return WORKFLOW_TO_CHAT_AREA[trimmed] ?? null;
}
