import type {
  AgentActivityItem,
  GatewayInboundFrame,
  HarnessAreaId,
  HarnessReceipt,
  HarnessThreadSnapshot,
  HarnessThreadState,
} from '../types';
import type { ChatMessage } from '../../../shared/types/chat';

export const FIXTURE_THREAD_ID = '10000000-0000-4000-8000-000000000101';
export const FIXTURE_RUN_ID = 'run-fixture-001';
export const FIXTURE_CMD_ID_1 = '10000000-0000-4000-8000-000000000201';
export const FIXTURE_CMD_ID_2 = '10000000-0000-4000-8000-000000000202';

export function makeThreadState(
  overrides: Partial<HarnessThreadState> = {},
): HarnessThreadState {
  return {
    threadStatus: 'idle',
    activeRunId: null,
    phase: 'idle',
    harnessArea: 'agent-home',
    pendingCommands: [],
    latestSummary: null,
    canWrite: true,
    ...overrides,
  };
}

export function makeSnapshot(
  overrides: Partial<HarnessThreadSnapshot> = {},
): HarnessThreadSnapshot {
  const state = overrides.state ?? makeThreadState();
  return {
    messages: [],
    state,
    latestSummary: state.latestSummary,
    canWrite: state.canWrite ?? true,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'user',
    text: 'Hello agent',
    ts: '2026-11-19T00:00:00.000Z',
    ...overrides,
  };
}

export function makeReceipt(
  overrides: Partial<HarnessReceipt> = {},
): HarnessReceipt {
  return {
    commandId: FIXTURE_CMD_ID_1,
    kind: 'send',
    status: 'accepted',
    updatedAt: '2026-11-19T00:00:01.000Z',
    ...overrides,
  };
}

export function makeActivityItems(): AgentActivityItem[] {
  return [
    { id: 'thinking-1', kind: 'thinking', text: 'Checking the repository layout' },
    {
      id: 'call-1',
      kind: 'tool',
      toolName: 'Read',
      status: 'completed',
      target: 'src/client/App.tsx',
    },
    {
      id: 'call-2',
      kind: 'tool',
      toolName: 'Grep',
      status: 'completed',
      target: 'useAgentChatSession',
    },
  ];
}

export function makeStateFrame(
  stateOverrides: Partial<HarnessThreadState> = {},
): GatewayInboundFrame {
  return {
    type: 'state',
    state: makeThreadState(stateOverrides),
  };
}

export function makeReceiptFrame(
  receiptOverrides: Partial<HarnessReceipt> = {},
): GatewayInboundFrame {
  return {
    type: 'receipt',
    receipt: makeReceipt(receiptOverrides),
  };
}

export function makeRunningTurnFrames(area: HarnessAreaId = 'agent-home'): GatewayInboundFrame[] {
  return [
    makeStateFrame({
      threadStatus: 'running',
      activeRunId: FIXTURE_RUN_ID,
      phase: 'running',
      harnessArea: area,
    }),
    {
      type: 'event',
      id: '10',
      data: {
        type: 'thinking',
        text: 'Inspecting files',
        seq: 1,
        runId: FIXTURE_RUN_ID,
      },
    },
    {
      type: 'event',
      id: '11',
      data: {
        type: 'tool_status',
        callId: 'tool-1',
        toolName: 'Read',
        status: 'running',
        args: { target: 'src/index.ts' },
        runId: FIXTURE_RUN_ID,
      },
    },
    {
      type: 'event',
      id: '12',
      data: {
        type: 'token',
        text: 'Here is ',
        streamOffset: 0,
        runId: FIXTURE_RUN_ID,
      },
    },
    {
      type: 'event',
      id: '13',
      data: {
        type: 'token',
        text: 'the answer.',
        streamOffset: 8,
        runId: FIXTURE_RUN_ID,
      },
    },
  ];
}
