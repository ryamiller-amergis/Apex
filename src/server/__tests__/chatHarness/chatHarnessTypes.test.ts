import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  HARNESS_AGENT_PHASES,
  HARNESS_AREA_IDS,
  HARNESS_COMMAND_KINDS,
  HARNESS_CONTEXT_KINDS,
  HARNESS_RECEIPT_REASONS,
  HARNESS_RECEIPT_STATUSES,
  HARNESS_RECREATE_REASONS,
  isHarnessAgentPhase,
  isHarnessAreaId,
  isHarnessCommandBody,
  isHarnessCommandFrame,
  isHarnessCommandKind,
  isHarnessContextKind,
  isHarnessContextRef,
  isHarnessControlMessage,
  isHarnessReceiptReason,
  isHarnessReceiptStatus,
  isHarnessRecreateReason,
  type AgentActivityItem,
  type HarnessCommandBody,
  type HarnessCommandFrame,
  type HarnessErrorFrame,
  type HarnessReceipt,
  type HarnessReceiptFrame,
  type HarnessStateFrame,
  type HarnessThreadSnapshot,
  type HarnessThreadState,
} from '../../../shared/types/chatHarness';
import type { BrainstormActivityItem } from '../../../shared/types/brainstorm';
import {
  isDurableInteractiveTurnSpecification,
  type DurableInteractiveTurnSpecification,
  type FrozenHarnessSpec,
} from '../../../shared/types/durableInteractiveTurn';
import {
  AI_RUN_INGEST_KINDS,
  isAiRunIngestKind,
  type AiRunIngestBody,
  type AiRunIngestResponse,
  type AiRunSummaryIngest,
  type AiRunTerminalIngest,
  type InteractiveTurnStageTimings,
} from '../../../shared/types/aiRunIngest';
import type {
  WorkerTierSafePropertyKey,
  WorkerTierTelemetryEventProperties,
} from '../../../shared/types/workerTierOperations';

const COMMAND_ID = '10000000-0000-4000-8000-000000000001';
const THREAD_ID = '10000000-0000-4000-8000-000000000002';
const TURN_ID = '10000000-0000-4000-8000-000000000003';
const RUN_ID = '20000000-0000-4000-8000-000000000001';
const ISO_TS = '2026-11-19T00:00:00.000Z';

const BASE_SPEC: DurableInteractiveTurnSpecification = {
  schemaVersion: 1,
  kind: 'interactive-turn',
  turnId: TURN_ID,
  threadId: THREAD_ID,
  userId: 'user-1',
  projectId: 'Apex',
  interactiveClass: 'fast',
  workflowClass: 'home-chat',
  model: 'claude-sonnet-4-6',
  effort: 'low',
  skill: null,
  currentMessage: {
    id: TURN_ID,
    text: 'Hello',
    hidden: false,
    attachments: [],
  },
  transcript: [],
  grounding: null,
  mcpServers: [],
  toolGrant: null,
  currentPrompt: 'Hello',
  recreationPrompt: 'Hello',
  deadlines: {
    absoluteTurnMs: 300_000,
    repositoryPreparationMs: null,
    firstEventMs: 30_000,
    toolCallMs: 60_000,
  },
};

const VALID_HARNESS_SPEC: FrozenHarnessSpec = {
  area: 'agent-home',
  version: 1,
  toolAllowlist: ['Read', 'Grep'],
  customTools: [
    {
      name: 'propose_prd_diff',
      description: 'Proposes a PRD change for review',
      inputSchema: { type: 'object', properties: { diff: { type: 'string' } } },
      writes: true,
      proxyTarget: 'prd-assistant/propose-diff',
    },
  ],
  writeConfirmation: [
    {
      tool: 'propose_prd_diff',
      writes: true,
      mode: 'ask',
    },
  ],
  safety: {
    repositoryCode: 'read',
    shell: 'none',
    settingSources: [],
  },
};

describe('TBI-006 DoD-0: command kinds, command bodies, frames, and control messages', () => {
  it('exports the five closed command kinds', () => {
    expect(HARNESS_COMMAND_KINDS).toEqual([
      'send',
      'steer',
      'summarize',
      'cancel',
      'retry',
    ]);
    for (const kind of HARNESS_COMMAND_KINDS) {
      expect(isHarnessCommandKind(kind)).toBe(true);
    }
    expect(isHarnessCommandKind('stop')).toBe(false);
    expect(isHarnessCommandKind('')).toBe(false);
    expect(isHarnessCommandKind(null)).toBe(false);
  });

  it('accepts valid command bodies for all five kinds', () => {
    const validCommands: HarnessCommandBody[] = [
      { commandId: COMMAND_ID, kind: 'send', text: 'Hello agent' },
      {
        commandId: COMMAND_ID,
        kind: 'send',
        text: '  ',
        model: 'claude-sonnet-4-6',
        attachments: [
          {
            id: 'att-1',
            name: 'notes.txt',
            type: 'text/plain',
            size: 10,
            content: 'hello text',
          },
        ],
        skill: { name: 'Brainstorm', path: '.cursor/skills/brainstorm/SKILL.md' },
      },
      { commandId: COMMAND_ID, kind: 'steer', text: 'Focus on tests first' },
      { commandId: COMMAND_ID, kind: 'summarize' },
      { commandId: COMMAND_ID, kind: 'cancel' },
      { commandId: COMMAND_ID, kind: 'retry', runId: RUN_ID },
    ];

    for (const command of validCommands) {
      expect(isHarnessCommandBody(command)).toBe(true);
      const frame: HarnessCommandFrame = { type: 'command', ...command };
      expect(isHarnessCommandFrame(frame)).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing commandId', { kind: 'cancel' }],
    ['malformed commandId', { commandId: 'not-a-uuid', kind: 'cancel' }],
    ['unknown kind', { commandId: COMMAND_ID, kind: 'abort' }],
    ['empty send without attachments', { commandId: COMMAND_ID, kind: 'send', text: '   ' }],
    [
      'empty send with empty attachments',
      { commandId: COMMAND_ID, kind: 'send', text: '', attachments: [] },
    ],
    [
      'send with non-string text',
      { commandId: COMMAND_ID, kind: 'send', text: 42 },
    ],
    [
      'send with empty model',
      { commandId: COMMAND_ID, kind: 'send', text: 'hi', model: '   ' },
    ],
    [
      'send with invalid skill',
      { commandId: COMMAND_ID, kind: 'send', text: 'hi', skill: { name: '', path: 'a' } },
    ],
    [
      'send with invalid attachment',
      {
        commandId: COMMAND_ID,
        kind: 'send',
        text: '',
        attachments: [{ id: 'att-1', name: 'x' }],
      },
    ],
    ['empty steer text', { commandId: COMMAND_ID, kind: 'steer', text: '' }],
    ['whitespace steer text', { commandId: COMMAND_ID, kind: 'steer', text: ' \n\t ' }],
    ['retry missing runId', { commandId: COMMAND_ID, kind: 'retry' }],
    ['retry empty runId', { commandId: COMMAND_ID, kind: 'retry', runId: '   ' }],
  ])('rejects invalid command body: %s', (_label, candidate) => {
    expect(isHarnessCommandBody(candidate)).toBe(false);
  });

  it('rejects malformed command frames', () => {
    expect(
      isHarnessCommandFrame({ type: 'receipt', commandId: COMMAND_ID, kind: 'cancel' }),
    ).toBe(false);
    expect(
      isHarnessCommandFrame({ type: 'command', commandId: 'bad', kind: 'cancel' }),
    ).toBe(false);
  });

  it('validates steer and cancel control channel messages', () => {
    expect(
      isHarnessControlMessage({
        kind: 'steer',
        threadId: THREAD_ID,
        runId: RUN_ID,
        commandId: COMMAND_ID,
        text: 'Change direction',
        sentAt: ISO_TS,
      }),
    ).toBe(true);
    expect(
      isHarnessControlMessage({
        kind: 'cancel',
        threadId: THREAD_ID,
        runId: RUN_ID,
        commandId: COMMAND_ID,
        sentAt: ISO_TS,
      }),
    ).toBe(true);
    expect(
      isHarnessControlMessage({
        kind: 'steer',
        threadId: THREAD_ID,
        runId: RUN_ID,
        commandId: COMMAND_ID,
        text: '   ',
        sentAt: ISO_TS,
      }),
    ).toBe(false);
    expect(
      isHarnessControlMessage({
        kind: 'cancel',
        threadId: 'not-a-uuid',
        runId: RUN_ID,
        commandId: COMMAND_ID,
        sentAt: ISO_TS,
      }),
    ).toBe(false);
    expect(
      isHarnessControlMessage({
        kind: 'summarize',
        threadId: THREAD_ID,
        runId: RUN_ID,
        commandId: COMMAND_ID,
        sentAt: ISO_TS,
      }),
    ).toBe(false);
  });
});

describe('TBI-006 DoD-1: receipt statuses and closed reasons', () => {
  it('exports the four receipt statuses', () => {
    expect(HARNESS_RECEIPT_STATUSES).toEqual([
      'accepted',
      'applied',
      'rejected',
      'queued',
    ]);
    for (const status of HARNESS_RECEIPT_STATUSES) {
      expect(isHarnessReceiptStatus(status)).toBe(true);
    }
    expect(isHarnessReceiptStatus('pending')).toBe(false);
  });

  it('exports all eleven closed receipt reasons', () => {
    const expectedReasons = [
      'Wait for this step to finish',
      'Turn had finished, sent as a new message',
      'Queued as follow-up',
      'You have read-only access to this chat',
      'Turn had already finished',
      'Stop did not reach the agent',
      'Wait for this reply to finish',
      'Could not summarize this conversation',
      'Command id already used',
      'Sign in again to continue',
      'Did not reach the agent',
    ];
    expect(HARNESS_RECEIPT_REASONS).toEqual(expectedReasons);
    expect(HARNESS_RECEIPT_REASONS).toHaveLength(11);
    for (const reason of expectedReasons) {
      expect(isHarnessReceiptReason(reason)).toBe(true);
    }
    expect(isHarnessReceiptReason('Arbitrary free-form error')).toBe(false);
  });

  it('supports receipts with and without optional reason and runId', () => {
    const accepted: HarnessReceipt = {
      commandId: COMMAND_ID,
      kind: 'send',
      status: 'accepted',
      runId: RUN_ID,
      updatedAt: ISO_TS,
    };
    const rejected: HarnessReceipt = {
      commandId: COMMAND_ID,
      kind: 'steer',
      status: 'rejected',
      reason: 'Wait for this step to finish',
      updatedAt: ISO_TS,
    };
    const frame: HarnessReceiptFrame = { type: 'receipt', receipt: rejected };
    expect(accepted.reason).toBeUndefined();
    expect(frame.receipt.reason).toBe('Wait for this step to finish');
  });
});

describe('TBI-006 DoD-2: state frame, snapshot, context refs, and recreate reasons', () => {
  it('carries threadStatus, activeRunId, phase, pendingCommands, and latestSummary on state frame and snapshot', () => {
    const state: HarnessThreadState = {
      threadStatus: 'running',
      activeRunId: RUN_ID,
      phase: 'running',
      harnessArea: 'brainstorm',
      pendingCommands: [
        { commandId: COMMAND_ID, kind: 'steer', status: 'accepted' },
      ],
      latestSummary: {
        id: 'sum-1',
        source: 'user',
        fallback: false,
        createdAt: ISO_TS,
      },
    };
    const stateFrame: HarnessStateFrame = { type: 'state', state };
    const snapshot: HarnessThreadSnapshot = {
      messages: [],
      state,
      latestSummary: state.latestSummary,
    };
    const errorFrame: HarnessErrorFrame = {
      type: 'error',
      code: 'INVALID_COMMAND',
      commandId: COMMAND_ID,
    };

    expect(stateFrame.state.threadStatus).toBe('running');
    expect(stateFrame.state.activeRunId).toBe(RUN_ID);
    expect(stateFrame.state.phase).toBe('running');
    expect(stateFrame.state.pendingCommands).toHaveLength(1);
    expect(snapshot.latestSummary?.fallback).toBe(false);
    expect(errorFrame.code).toBe('INVALID_COMMAND');

    expect(HARNESS_AGENT_PHASES).toEqual([
      'idle',
      'starting',
      'resuming',
      'recreating',
      'running',
      'summarizing',
    ]);
    for (const phase of HARNESS_AGENT_PHASES) {
      expect(isHarnessAgentPhase(phase)).toBe(true);
    }
    expect(isHarnessAgentPhase('stopped')).toBe(false);
  });

  it('validates context kinds and context refs', () => {
    expect(HARNESS_CONTEXT_KINDS).toEqual([
      'prd',
      'brainstorm-session',
      'interview',
      'adr',
      'design-doc',
      'release',
      'qa-suite',
      'standup-session',
      'build-intake',
      'work-item',
    ]);
    for (const kind of HARNESS_CONTEXT_KINDS) {
      expect(isHarnessContextKind(kind)).toBe(true);
      expect(isHarnessContextRef({ kind, id: 'ctx-1' })).toBe(true);
    }
    expect(isHarnessContextKind('ui-lab')).toBe(false);
    expect(isHarnessContextRef({ kind: 'prd', id: '   ' })).toBe(false);
    expect(isHarnessContextRef({ kind: 'unknown', id: 'ctx-1' })).toBe(false);
    expect(isHarnessContextRef(null)).toBe(false);
  });

  it('validates recreation reasons', () => {
    expect(HARNESS_RECREATE_REASONS).toEqual([
      'deploy',
      'folder-change',
      'replica-move',
      'sdk-version',
      'idle-eviction',
      'unknown',
    ]);
    for (const reason of HARNESS_RECREATE_REASONS) {
      expect(isHarnessRecreateReason(reason)).toBe(true);
    }
    expect(isHarnessRecreateReason('manual')).toBe(false);
  });
});

describe('TBI-006 DoD-3: twelve area ids and general AgentActivityItem', () => {
  it('exports all 12 area ids and explicitly excludes ui-lab', () => {
    expect(HARNESS_AREA_IDS).toEqual([
      'agent-home',
      'interview',
      'adr',
      'prd-assistant',
      'design-doc-assistant',
      'ask-apex',
      'calendar-work-item',
      'qa-lab',
      'brainstorm',
      'cab-release',
      'build-intake',
      'standup-participant',
    ]);
    expect(HARNESS_AREA_IDS).toHaveLength(12);
    expect((HARNESS_AREA_IDS as readonly string[]).includes('ui-lab')).toBe(false);

    for (const area of HARNESS_AREA_IDS) {
      expect(isHarnessAreaId(area)).toBe(true);
    }
    expect(isHarnessAreaId('ui-lab')).toBe(false);
    expect(isHarnessAreaId('unknown-area')).toBe(false);
  });

  it('generalizes BrainstormActivityItem into AgentActivityItem without breaking compatibility', () => {
    const brainstormThinking: BrainstormActivityItem = {
      id: 'act-1',
      kind: 'thinking',
      text: 'Checking requirements',
    };
    const brainstormTool: BrainstormActivityItem = {
      id: 'act-2',
      kind: 'tool',
      toolName: 'Read',
      status: 'completed',
      target: 'src/shared/types/chatHarness.ts',
      result: 'ok',
    };
    const grouped: AgentActivityItem = {
      id: 'act-3',
      kind: 'tool-group',
      status: 'running',
      tools: [
        {
          id: 't-1',
          toolName: 'Read',
          status: 'completed',
          target: 'a.ts',
        },
      ],
    };
    const summary: AgentActivityItem = {
      id: 'act-4',
      kind: 'summary',
      status: 'fallback',
      text: 'Summary trimmed',
    };

    const items: AgentActivityItem[] = [
      brainstormThinking,
      brainstormTool,
      grouped,
      summary,
    ];
    expect(items).toHaveLength(4);
  });
});

describe('S1 additive contracts: durableInteractiveTurn, aiRunIngest, workerTierOperations', () => {
  it('accepts a valid harness block and custom-tool MCP descriptor on DurableInteractiveTurnSpecification', () => {
    expect(
      isDurableInteractiveTurnSpecification({
        ...BASE_SPEC,
        harness: { ...VALID_HARNESS_SPEC, operation: 'summarize' },
        mcpServers: [
          {
            kind: 'custom-tool',
            serverName: 'harness-tools',
            toolName: 'propose_prd_diff',
            proxyTarget: 'prd-assistant/propose-diff',
            writes: true,
            enableRepoBrowse: false,
          },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    ['unknown harness area', { ...VALID_HARNESS_SPEC, area: 'ui-lab' }],
    ['non-positive harness version', { ...VALID_HARNESS_SPEC, version: 0 }],
    ['fractional harness version', { ...VALID_HARNESS_SPEC, version: 1.5 }],
    ['unknown harness operation', { ...VALID_HARNESS_SPEC, operation: 'steer' }],
    ['non-string toolAllowlist entry', { ...VALID_HARNESS_SPEC, toolAllowlist: [123] }],
    [
      'custom tool missing proxyTarget',
      {
        ...VALID_HARNESS_SPEC,
        customTools: [{ ...VALID_HARNESS_SPEC.customTools[0], proxyTarget: '' }],
      },
    ],
    [
      'custom tool non-object inputSchema',
      {
        ...VALID_HARNESS_SPEC,
        customTools: [{ ...VALID_HARNESS_SPEC.customTools[0], inputSchema: [] }],
      },
    ],
    [
      'invalid writeConfirmation mode',
      {
        ...VALID_HARNESS_SPEC,
        writeConfirmation: [{ tool: 'propose_prd_diff', writes: true, mode: 'auto' }],
      },
    ],
    [
      'non-empty safety.settingSources',
      {
        ...VALID_HARNESS_SPEC,
        safety: { repositoryCode: 'read', shell: 'none', settingSources: ['project'] },
      },
    ],
    [
      'invalid safety.shell',
      {
        ...VALID_HARNESS_SPEC,
        safety: { repositoryCode: 'read', shell: 'unrestricted', settingSources: [] },
      },
    ],
  ])('rejects malformed harness block: %s', (_label, harness) => {
    expect(
      isDurableInteractiveTurnSpecification({
        ...BASE_SPEC,
        harness,
      }),
    ).toBe(false);
  });

  it.each([
    [
      'enableRepoBrowse true',
      {
        kind: 'custom-tool',
        serverName: 'harness-tools',
        toolName: 'propose_prd_diff',
        proxyTarget: 'prd-assistant/propose-diff',
        writes: true,
        enableRepoBrowse: true,
      },
    ],
    [
      'empty proxyTarget',
      {
        kind: 'custom-tool',
        serverName: 'harness-tools',
        toolName: 'propose_prd_diff',
        proxyTarget: '  ',
        writes: false,
        enableRepoBrowse: false,
      },
    ],
    [
      'non-boolean writes',
      {
        kind: 'custom-tool',
        serverName: 'harness-tools',
        toolName: 'propose_prd_diff',
        proxyTarget: 'prd-assistant/propose-diff',
        writes: 'yes',
        enableRepoBrowse: false,
      },
    ],
  ])('rejects malformed custom-tool MCP descriptor: %s', (_label, descriptor) => {
    expect(
      isDurableInteractiveTurnSpecification({
        ...BASE_SPEC,
        mcpServers: [descriptor],
      }),
    ).toBe(false);
  });

  it('supports summary ingest kind, terminal recreateReason/clearCursorAgentId, and pendingControl', () => {
    expect(AI_RUN_INGEST_KINDS).toContain('summary');
    expect(isAiRunIngestKind('summary')).toBe(true);

    const summaryIngest: AiRunSummaryIngest = {
      kind: 'summary',
      dispatchMessageId: COMMAND_ID,
      status: 'completed',
      text: 'Condensed conversation',
      commandId: COMMAND_ID,
      coversThroughOrdinal: 42,
    };
    const timings: InteractiveTurnStageTimings = {
      agentMode: 'recreated',
      recreateReason: 'deploy',
    };
    const terminalIngest: AiRunTerminalIngest = {
      kind: 'terminal',
      dispatchMessageId: COMMAND_ID,
      status: 'completed',
      clearCursorAgentId: true,
      recreateReason: 'sdk-version',
      stageTimings: timings,
    };
    const bodies: AiRunIngestBody[] = [summaryIngest, terminalIngest];
    const response: AiRunIngestResponse = {
      ok: true,
      cancelRequested: false,
      pendingControl: [
        { commandId: COMMAND_ID, kind: 'steer', text: 'Keep it brief' },
      ],
    };

    expect(bodies).toHaveLength(2);
    expect(response.pendingControl?.[0].kind).toBe('steer');
  });

  it('adds acquisitionMode and recreateReason to worker-tier telemetry safe property keys', () => {
    const keys: WorkerTierSafePropertyKey[] = [
      'area',
      'acquisitionMode',
      'recreateReason',
    ];
    const props: WorkerTierTelemetryEventProperties = {
      area: 'agent-home',
      acquisitionMode: 'resumed',
      recreateReason: 'deploy',
    };
    expect(keys).toEqual(['area', 'acquisitionMode', 'recreateReason']);
    expect(props.acquisitionMode).toBe('resumed');
    expect(props.recreateReason).toBe('deploy');
  });
});

describe('VT-47: chatHarness shared module import-graph isolation', () => {
  const SHARED_ROOT = resolve(__dirname, '../../../shared');
  const ENTRY_FILE = resolve(SHARED_ROOT, 'types/chatHarness.ts');

  function extractSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    const fromPattern = /\bfrom\s+['"]([^'"]+)['"]/g;
    let match = fromPattern.exec(source);
    while (match) {
      specifiers.push(match[1]);
      match = fromPattern.exec(source);
    }
    const inlineImportPattern = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
    match = inlineImportPattern.exec(source);
    while (match) {
      specifiers.push(match[1]);
      match = inlineImportPattern.exec(source);
    }
    return specifiers;
  }

  it('has zero runtime imports and zero client or server dependencies across its import graph', () => {
    const entrySource = readFileSync(ENTRY_FILE, 'utf8');
    // Every top-level import in chatHarness.ts must be type-only and stay inside src/shared/.
    const importLines = entrySource
      .split(/\r?\n/)
      .filter((line) => /^\s*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).toMatch(/^\s*import\s+type\b/);
    }
    for (const specifier of extractSpecifiers(entrySource)) {
      expect(specifier.startsWith('.')).toBe(true);
    }

    const FORBIDDEN_PACKAGES = [
      /^node:/,
      /^express$/,
      /^pg$/,
      /^drizzle-orm/,
      /^react(?:-dom)?$/,
      /^ws$/,
      /^@cursor\/sdk/,
    ];

    const queue = [ENTRY_FILE];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (visited.has(file)) continue;
      visited.add(file);

      const source = readFileSync(file, 'utf8');
      for (const specifier of extractSpecifiers(source)) {
        if (specifier.startsWith('.')) {
          const resolved = resolve(dirname(file), `${specifier}.ts`);
          const normalized = resolved.replace(/\\/g, '/');
          expect(normalized).not.toMatch(/\/src\/(client|server)\//);
          expect(normalized).toMatch(/\/src\/shared\//);
          if (existsSync(resolved)) {
            queue.push(resolved);
          }
        } else {
          for (const forbidden of FORBIDDEN_PACKAGES) {
            expect(specifier).not.toMatch(forbidden);
          }
        }
      }
    }

    expect(visited.size).toBeGreaterThanOrEqual(2);
  });
});
