/**
 * TBI-021 DoD-0..2, VT-48:
 * Verifies .cursor/rules/agent-chat-surfaces.mdc documents the client chat
 * harness runtime, AgentHarnessPanel five slots, steer and summarize actions,
 * keeps the useAgentChatSession mandate, and has no contradiction with
 * .cursor/rules/chat-harness.mdc.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const AGENT_CHAT_SURFACES_RULE_PATH = resolve(
  REPO_ROOT,
  '.cursor/rules/agent-chat-surfaces.mdc',
);
const CHAT_HARNESS_RULE_PATH = resolve(
  REPO_ROOT,
  '.cursor/rules/chat-harness.mdc',
);

const REQUIRED_PANEL_SLOTS = [
  'header',
  'sidePanel',
  'composerAccessory',
  'messageActions',
  'proposal',
] as const;

const REQUIRED_HARNESS_HOOK_FIELDS = [
  'harnessArea',
  'steer',
  'summarize',
  'connectionState',
  'pendingCommands',
  'lastReceipt',
  'activity',
  'summaryNotice',
  'canWrite',
] as const;

describe('agent-chat-surfaces.mdc rule verification (TBI-021 / VT-48)', () => {
  it('TBI-021 DoD-1: preserves frontmatter and requires every chat surface to build on useAgentChatSession', () => {
    expect(existsSync(AGENT_CHAT_SURFACES_RULE_PATH)).toBe(true);
    const ruleText = readFileSync(AGENT_CHAT_SURFACES_RULE_PATH, 'utf8');

    // Exact frontmatter keys and values
    expect(ruleText).toMatch(
      /^---\r?\ndescription:\s*Frontend agent chat\/streaming surfaces must build on the common useAgentChatSession hook\r?\nglobs:\s*src\/client\/\*\*\/\*\.\{ts,tsx\}\r?\nalwaysApply:\s*false\r?\n---/,
    );

    // Core mandate
    expect(ruleText).toMatch(/MUST build on the shared hook/i);
    expect(ruleText).toMatch(/useAgentChatSession/);
    expect(ruleText).toMatch(/src\/client\/hooks\/useAgentChatSession\.ts/);

    // Hook contract sections and additive harness fields
    expect(ruleText).toMatch(/\*\*Options\*\*/);
    expect(ruleText).toMatch(/\*\*Actions\*\*/);
    expect(ruleText).toMatch(/\*\*Derived flags\*\*/);
    expect(ruleText).toMatch(/\*\*Stream state\*\*/);

    for (const field of REQUIRED_HARNESS_HOOK_FIELDS) {
      expect(ruleText).toContain(`\`${field}\``);
    }

    // Sanctioned exception to react-coding-standards.mdc updated for harness runtime
    expect(ruleText).toMatch(/react-coding-standards\.mdc/);
    expect(ruleText).toMatch(/TanStack Query/i);
    expect(ruleText).toMatch(/src\/client\/chatHarness\//);
  });

  it('TBI-021 DoD-0 / VT-48: describes the client chat harness runtime behind useAgentChatSession', () => {
    const ruleText = readFileSync(AGENT_CHAT_SURFACES_RULE_PATH, 'utf8');

    expect(ruleText).toContain('src/client/chatHarness/');
    expect(ruleText).toMatch(/WebSocket/i);
    expect(ruleText).toMatch(/reconnect/i);
    expect(ruleText).toMatch(/replay/i);
    expect(ruleText).toMatch(/HTTP/i);
    expect(ruleText).toMatch(/server-authoritative/i);
    expect(ruleText).toMatch(/telemetry/i);
    // Threads without a harness area keep HTTP send/cancel/retry path
    expect(ruleText).toMatch(/without a harness area/i);
  });

  it('TBI-021 DoD-0 / VT-48: describes AgentHarnessPanel, all five slots, write confirmation, and testId preservation', () => {
    const ruleText = readFileSync(AGENT_CHAT_SURFACES_RULE_PATH, 'utf8');

    expect(ruleText).toContain('AgentHarnessPanel');
    expect(ruleText).toContain(
      'src/client/components/agentChat/AgentHarnessPanel.tsx',
    );

    for (const slot of REQUIRED_PANEL_SLOTS) {
      expect(ruleText).toContain(`\`${slot}\``);
    }

    // Proposal slot requires explicit user confirmation and is never auto-approved
    expect(ruleText).toMatch(/explicit user confirmation/i);
    expect(ruleText).toMatch(/never auto-approved/i);

    // Preserving existing data-testid values
    expect(ruleText).toContain('`data-testid`');
    expect(ruleText).toContain('`testIdPrefix`');
    expect(ruleText).toContain('`testIds`');
  });

  it('TBI-021 DoD-0 / VT-48: describes steer and summarize, server-owned 5-steer cap, and read-only enforcement', () => {
    const ruleText = readFileSync(AGENT_CHAT_SURFACES_RULE_PATH, 'utf8');

    expect(ruleText).toContain('`steer(text)`');
    expect(ruleText).toContain('`summarize()`');
    expect(ruleText).toContain('`lastReceipt`');
    expect(ruleText).toContain('`summaryNotice`');
    expect(ruleText).toMatch(/5-steer cap|five-steer cap/i);
    expect(ruleText).toMatch(/summary lifecycle/i);
    expect(ruleText).toMatch(/`canWrite:\s*false`/);
    expect(ruleText).toMatch(/read-only/i);
  });

  it('TBI-021 DoD-2 / VT-48: aligns with .cursor/rules/chat-harness.mdc with no contradictions', () => {
    expect(existsSync(AGENT_CHAT_SURFACES_RULE_PATH)).toBe(true);
    expect(existsSync(CHAT_HARNESS_RULE_PATH)).toBe(true);

    const surfaceRule = readFileSync(AGENT_CHAT_SURFACES_RULE_PATH, 'utf8');
    const harnessRule = readFileSync(CHAT_HARNESS_RULE_PATH, 'utf8');

    // Mutual cross-references between the two rules
    expect(harnessRule).toContain('.cursor/rules/agent-chat-surfaces.mdc');
    expect(surfaceRule).toContain('.cursor/rules/chat-harness.mdc');

    // Both rules agree on shared hook, harness panel, area profiles, and SDK adapter
    expect(harnessRule).toContain('useAgentChatSession');
    expect(surfaceRule).toContain('useAgentChatSession');
    expect(harnessRule).toMatch(/harness panel/i);
    expect(surfaceRule).toContain('AgentHarnessPanel');
    expect(surfaceRule).toContain('src/server/services/chatHarness/areaProfiles.ts');
    expect(surfaceRule).toContain('src/server/services/cursorSdkAdapter/');

    // Old SSE / EventSource / useChatStream transport claims are removed so they do not contradict the harness transport
    expect(surfaceRule).not.toMatch(/wraps\s+`?useChatStream`?/i);
    expect(surfaceRule).not.toContain('useChatStream');
    expect(surfaceRule).not.toContain('new EventSource');

    // Plain control-flow language (no policy-gate metaphors)
    expect(surfaceRule).not.toMatch(/\bfail[- ]closed\b/i);
    expect(surfaceRule).not.toMatch(/\bfail[- ]open\b/i);
  });
});
