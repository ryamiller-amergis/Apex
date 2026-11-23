/**
 * Recorded Cursor SDK stream fixtures for all 12 governed HARNESS_AREA_IDS
 * (TBI-015 / TBI-011 DoD-3 / PBI-007 AC-1 / VT-18).
 *
 * Each area carries realistic recorded streams for:
 *  - Normal turn (thinking + tool call where allowed + text tokens + usage)
 *  - Area custom tool payloads matching every tool declared in `areaProfiles.ts`
 *  - Mid-turn steer stream (pre-steer events -> steer -> updated response)
 *  - Summarize streams (full completed summary + fallback trimmed summary)
 *  - Cancel stream (starts streaming then yields cleanly on cancel)
 *  - Resume stream (resumed stored `cursorAgentId`)
 *  - Forced recreation stream (pre-1.4.0 `cursorAgentId` returning `agent_not_found`,
 *    multi-turn prior transcript, concrete anchor fact referenced directly in
 *    the reply with zero repeat-context phrasing)
 */
import type {
  HarnessAreaId,
  HarnessContextRef,
} from '../../../shared/types/chatHarness';
import { BRAINSTORM_UPDATE_ARTIFACT_TOOL } from '../../../shared/types/brainstormArtifact';
import type { WorkerCursorExecutionRun } from '../../services/aiRunsWorker/cursorExecution';
import type {
  CursorStreamEvent,
  CursorTokenUsage,
} from '../../services/cursorExecutionCore';
import type {
  RecreationMessage,
  RecreationSummaryInput,
} from '../../services/chatHarness/chatHarnessRecreation';

export const REPEAT_CONTEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /could you repeat/i,
  /please restate/i,
  /what were we discussing/i,
  /remind me/i,
  /start over/i,
  /don['’]t have (?:the )?(?:prior |previous )?context/i,
  /share (?:the )?(?:earlier|previous) (?:details|context) again/i,
  /tell me again what/i,
];

export interface RecordedCustomToolPayload {
  readonly toolName: string;
  readonly proxyTarget: string;
  readonly writes: boolean;
  readonly args: Record<string, unknown>;
}

export interface RecordedAreaHarnessFixture {
  readonly area: HarnessAreaId;
  readonly context: HarnessContextRef | null;
  readonly skillPath: string | null;
  readonly model: string;
  readonly areaKeyContext: string;
  readonly normalTurn: Readonly<{
    userPrompt: string;
    events: ReadonlyArray<CursorStreamEvent>;
    expectedReplySubstring: string;
    usage: CursorTokenUsage;
  }>;
  readonly customToolPayloads: ReadonlyArray<RecordedCustomToolPayload>;
  readonly steerTurn: Readonly<{
    initialPrompt: string;
    steerText: string;
    preSteerEvents: ReadonlyArray<CursorStreamEvent>;
    postSteerEvents: ReadonlyArray<CursorStreamEvent>;
    expectedSteeredSubstring: string;
  }>;
  readonly summarize: Readonly<{
    fullSummaryText: string;
    fullEvents: ReadonlyArray<CursorStreamEvent>;
    fallbackSummaryText: string;
    fallbackEvents: ReadonlyArray<CursorStreamEvent>;
  }>;
  readonly cancelTurn: Readonly<{
    userPrompt: string;
    initialEvents: ReadonlyArray<CursorStreamEvent>;
  }>;
  readonly resumeTurn: Readonly<{
    priorCursorAgentId: string;
    userPrompt: string;
    events: ReadonlyArray<CursorStreamEvent>;
    expectedReplySubstring: string;
  }>;
  readonly recreateTurn: Readonly<{
    priorLegacyCursorAgentId: string;
    priorMessages: ReadonlyArray<RecreationMessage>;
    priorFullSummary: RecreationSummaryInput;
    priorFallbackSummary: RecreationSummaryInput;
    followUpPrompt: string;
    anchorFact: string;
    events: ReadonlyArray<CursorStreamEvent>;
  }>;
}

const SAMPLE_THREAD_ID = '22222222-2222-4222-8222-222222222222';

function buildNormalEvents(input: {
  thinking: string;
  toolName?: string;
  toolTarget?: string;
  chunks: ReadonlyArray<string>;
  usage: CursorTokenUsage;
}): ReadonlyArray<CursorStreamEvent> {
  const events: CursorStreamEvent[] = [
    { type: 'thinking', text: input.thinking, thinking_duration_ms: 42 },
  ];
  if (input.toolName) {
    events.push(
      {
        type: 'tool_call',
        name: input.toolName,
        call_id: `call-${input.toolName}-1`,
        status: 'started',
        args: { path: input.toolTarget ?? 'src/server/index.ts' },
      },
      {
        type: 'tool_call',
        name: input.toolName,
        call_id: `call-${input.toolName}-1`,
        status: 'completed',
        args: { path: input.toolTarget ?? 'src/server/index.ts' },
        result: { ok: true },
      },
    );
  }
  for (const text of input.chunks) {
    events.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    });
  }
  events.push({ type: 'usage', usage: input.usage });
  events.push({ type: 'apex_turn_end', usage: input.usage });
  return events;
}

function buildSimpleReplyEvents(
  chunks: ReadonlyArray<string>,
  usage: CursorTokenUsage = {
    inputTokens: 920,
    outputTokens: 210,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
  },
): ReadonlyArray<CursorStreamEvent> {
  return [
    { type: 'thinking', text: 'Checking prior context and drafting reply.' },
    ...chunks.map(
      (text): CursorStreamEvent => ({
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      }),
    ),
    { type: 'usage', usage },
    { type: 'apex_turn_end', usage },
  ];
}

function buildSummarizeEvents(
  summary: string,
  fallback: boolean,
): ReadonlyArray<CursorStreamEvent> {
  return [
    { type: 'summary', status: 'running' },
    {
      type: 'summary',
      status: fallback ? 'fallback' : 'completed',
      fallback,
      summary,
    },
  ];
}

export const RECORDED_HARNESS_STREAMS: Readonly<
  Record<HarnessAreaId, RecordedAreaHarnessFixture>
> = {
  'agent-home': {
    area: 'agent-home',
    context: null,
    skillPath: null,
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'Agent Home workspace: AI-Pilot main branch',
    normalTurn: {
      userPrompt: 'Explain how the interactive WebSocket gateway deduplicates replayed events.',
      events: buildNormalEvents({
        thinking: 'Reading interactiveGatewayService.ts to trace eventId deduplication.',
        toolName: 'Read',
        toolTarget: 'src/server/services/interactiveGatewayService.ts',
        chunks: [
          'The gateway buffers live events during replay and tracks ',
          'delivered ordinals in `sentEventIds` so duplicates are dropped.',
        ],
        usage: {
          inputTokens: 1420,
          outputTokens: 310,
          cacheReadTokens: 640,
          cacheWriteTokens: 120,
        },
      }),
      expectedReplySubstring: 'sentEventIds',
      usage: {
        inputTokens: 1420,
        outputTokens: 310,
        cacheReadTokens: 640,
        cacheWriteTokens: 120,
      },
    },
    customToolPayloads: [
      {
        toolName: 'propose_ado_work_item_write',
        proxyTarget: 'ado-skills/propose-work-item-write',
        writes: true,
        args: {
          operation: 'update',
          workItemId: 4821,
          fields: { 'System.State': 'Active' },
          summary: 'Move PBI 4821 to Active',
        },
      },
    ],
    steerTurn: {
      initialPrompt: 'Summarize recent gateway changes.',
      steerText: 'Focus specifically on receipt frame deduplication.',
      preSteerEvents: [
        { type: 'thinking', text: 'Inspecting gateway frame handlers.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Focusing on receipt frames: `rememberReceiptKey` bounds dedupe to 500 keys.',
      ]),
      expectedSteeredSubstring: 'rememberReceiptKey',
    },
    summarize: {
      fullSummaryText:
        'User investigated interactive gateway deduplication and receipt frame handling in AI-Pilot.',
      fullEvents: buildSummarizeEvents(
        'User investigated interactive gateway deduplication and receipt frame handling in AI-Pilot.',
        false,
      ),
      fallbackSummaryText:
        'FALLBACK_TRIMMED_AGENT_HOME_SUMMARY: truncated transcript excerpt.',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_AGENT_HOME_SUMMARY: truncated transcript excerpt.',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Audit every route in the repository.',
      initialEvents: [
        { type: 'thinking', text: 'Starting full route scan.' },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Scanning routes...' }] },
        },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-home-v140',
      userPrompt: 'What is the cap on `sentReceiptKeys`?',
      events: buildSimpleReplyEvents([
        'Continuing our gateway review: `MAX_DEDUPED_RECEIPTS` caps the ring at 500 entries.',
      ]),
      expectedReplySubstring: 'MAX_DEDUPED_RECEIPTS',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-agent-home',
      priorMessages: [
        {
          role: 'user',
          text: 'We are planning rollout wave 3 for tenant Northwind-904.',
          timestamp: '2026-11-18T14:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Recorded tenant Northwind-904 for rollout wave 3 with canary monitoring enabled.',
          timestamp: '2026-11-18T14:00:15.000Z',
        },
        {
          role: 'user',
          text: 'Keep the rollback window at 30 minutes.',
          timestamp: '2026-11-18T14:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Noted: 30-minute rollback window for Northwind-904.',
          timestamp: '2026-11-18T14:01:12.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Rollout wave 3 is scoped for tenant Northwind-904 with canary monitoring and a 30-minute rollback window.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_AGENT_HOME_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Draft the final rollout checklist item for that tenant.',
      anchorFact: 'Northwind-904',
      events: buildSimpleReplyEvents([
        'Final checklist item for Northwind-904 (wave 3): verify canary health metrics before closing the 30-minute rollback window.',
      ]),
    },
  },

  interview: {
    area: 'interview',
    context: { kind: 'interview', id: 'int-101' },
    skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'Interview session int-101: Self-service billing exports',
    normalTurn: {
      userPrompt: 'Finance teams need monthly CSV exports of invoice line items.',
      events: buildNormalEvents({
        thinking: 'Clarifying product requirements without repository reads.',
        chunks: [
          'Got it — monthly invoice line-item CSV exports for Finance. ',
          'Who should have permission to download exports across business units?',
        ],
        usage: {
          inputTokens: 1180,
          outputTokens: 245,
          cacheReadTokens: 300,
          cacheWriteTokens: 80,
        },
      }),
      expectedReplySubstring: 'monthly invoice line-item CSV exports',
      usage: {
        inputTokens: 1180,
        outputTokens: 245,
        cacheReadTokens: 300,
        cacheWriteTokens: 80,
      },
    },
    customToolPayloads: [],
    steerTurn: {
      initialPrompt: 'Ask about export scheduling.',
      steerText: 'Skip scheduling; focus on audit logging requirements.',
      preSteerEvents: [
        { type: 'thinking', text: 'Drafting next discovery question.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Shifting to audit logging: should every CSV download record user ID, timestamp, and filter criteria?',
      ]),
      expectedSteeredSubstring: 'audit logging',
    },
    summarize: {
      fullSummaryText:
        'Discovery confirmed monthly CSV invoice exports for Finance with mandatory download audit trails.',
      fullEvents: buildSummarizeEvents(
        'Discovery confirmed monthly CSV invoice exports for Finance with mandatory download audit trails.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_INTERVIEW_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_INTERVIEW_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'List all possible edge cases for multi-currency rounding.',
      initialEvents: [
        { type: 'thinking', text: 'Enumerating currency rounding questions.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-interview-v140',
      userPrompt: 'Only Billing Admins should download exports.',
      events: buildSimpleReplyEvents([
        'Captured: Billing Admins only for CSV downloads. Next, what retention period applies to generated files?',
      ]),
      expectedReplySubstring: 'Billing Admins',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-interview',
      priorMessages: [
        {
          role: 'user',
          text: 'The target persona is Regional Controller for EMEA ledger close.',
          timestamp: '2026-11-18T15:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Captured persona: Regional Controller during EMEA ledger close.',
          timestamp: '2026-11-18T15:00:10.000Z',
        },
        {
          role: 'user',
          text: 'Exports must complete before 06:00 UTC on business day 1.',
          timestamp: '2026-11-18T15:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Recorded SLA: complete before 06:00 UTC on business day 1.',
          timestamp: '2026-11-18T15:01:12.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Interview int-101 targets the Regional Controller persona for EMEA ledger close with a 06:00 UTC business day 1 SLA.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_INTERVIEW_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Move to delivery constraints for this export.',
      anchorFact: 'EMEA ledger close',
      events: buildSimpleReplyEvents([
        'For delivery of the EMEA ledger close export (targeting 06:00 UTC on business day 1), what maximum file size should we support?',
      ]),
    },
  },

  adr: {
    area: 'adr',
    context: { kind: 'adr', id: 'adr-204' },
    skillPath: '.cursor/skills/adr-interview/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'ADR-204: Interactive control plane transport',
    normalTurn: {
      userPrompt: 'Compare Redis Pub/Sub vs Postgres LISTEN/NOTIFY for steer delivery.',
      events: buildNormalEvents({
        thinking: 'Checking existing interactiveLiveBus.ts and pgNotifyService.ts.',
        toolName: 'Grep',
        toolTarget: 'src/server/services/interactiveLiveBus.ts',
        chunks: [
          'Redis Pub/Sub provides sub-50ms fast-path steer delivery while ',
          'Postgres pendingControl acts as the durable slow-path backstop.',
        ],
        usage: {
          inputTokens: 1650,
          outputTokens: 340,
          cacheReadTokens: 700,
          cacheWriteTokens: 100,
        },
      }),
      expectedReplySubstring: 'Redis Pub/Sub',
      usage: {
        inputTokens: 1650,
        outputTokens: 340,
        cacheReadTokens: 700,
        cacheWriteTokens: 100,
      },
    },
    customToolPayloads: [],
    steerTurn: {
      initialPrompt: 'Draft the consequences section of ADR-204.',
      steerText: 'Highlight failover behavior when Redis is unavailable.',
      preSteerEvents: [
        { type: 'thinking', text: 'Drafting ADR consequences.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Consequences: when Redis is unavailable, heartbeat ingest delivers pendingControl cleanly with bounded latency.',
      ]),
      expectedSteeredSubstring: 'pendingControl',
    },
    summarize: {
      fullSummaryText:
        'ADR-204 selected Redis Pub/Sub fast path plus Postgres pendingControl fallback for steer/cancel.',
      fullEvents: buildSummarizeEvents(
        'ADR-204 selected Redis Pub/Sub fast path plus Postgres pendingControl fallback for steer/cancel.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_ADR_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_ADR_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Generate full sequence diagrams for every failure mode.',
      initialEvents: [
        { type: 'thinking', text: 'Preparing ADR failure mode diagrams.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-adr-v140',
      userPrompt: 'Add the security trade-off regarding payload logging.',
      events: buildSimpleReplyEvents([
        'Added to ADR-204: control bus logs commandId and disposition only, never steer text.',
      ]),
      expectedReplySubstring: 'ADR-204',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-adr',
      priorMessages: [
        {
          role: 'user',
          text: 'Decision ADR-204 must preserve single-writer ownership per thread using Dapr actor locks.',
          timestamp: '2026-11-18T16:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Recorded invariant: Dapr actor locks guarantee single-writer ownership per thread.',
          timestamp: '2026-11-18T16:00:20.000Z',
        },
        {
          role: 'user',
          text: 'Reject out-of-order dispatch fences with HTTP 409.',
          timestamp: '2026-11-18T16:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Added fencing rule: stale dispatch fences return HTTP 409.',
          timestamp: '2026-11-18T16:01:15.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'ADR-204 enforces single-writer ownership via Dapr actor locks and rejects stale dispatch fences with HTTP 409.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_ADR_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Summarize the migration impact section now.',
      anchorFact: 'Dapr actor locks',
      events: buildSimpleReplyEvents([
        'Migration impact: existing threads transition onto Dapr actor locks with HTTP 409 fencing without schema downtime.',
      ]),
    },
  },

  'prd-assistant': {
    area: 'prd-assistant',
    context: { kind: 'prd', id: 'prd-301' },
    skillPath: '.cursor/skills/to-prd/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'PRD-301: Shared Chat Harness v2',
    normalTurn: {
      userPrompt: 'Tighten PBI-007 acceptance criteria for SDK upgrade recreation.',
      events: buildNormalEvents({
        thinking: 'Reviewing PRD-301 PBI-007 acceptance criteria.',
        toolName: 'Read',
        toolTarget: '.ai-pilot/local-dev/feat-002/prd.md',
        chunks: [
          'Updated PBI-007 AC-1 to require bounded handoff recreation on ',
          'pre-1.4.0 agent_not_found without asking the user to repeat context.',
        ],
        usage: {
          inputTokens: 1840,
          outputTokens: 390,
          cacheReadTokens: 820,
          cacheWriteTokens: 110,
        },
      }),
      expectedReplySubstring: 'PBI-007 AC-1',
      usage: {
        inputTokens: 1840,
        outputTokens: 390,
        cacheReadTokens: 820,
        cacheWriteTokens: 110,
      },
    },
    customToolPayloads: [
      {
        toolName: 'update_prd',
        proxyTarget: 'prd-assistant/update-prd',
        writes: true,
        args: {
          prdId: 'prd-301',
          threadId: SAMPLE_THREAD_ID,
          section: 'content',
          content: '# PRD-301\nRevised acceptance criteria.',
        },
      },
      {
        toolName: 'add_test_case',
        proxyTarget: 'prd-assistant/add-test-case',
        writes: true,
        args: {
          prdId: 'prd-301',
          threadId: SAMPLE_THREAD_ID,
          pbiId: 'PBI-007',
          title: 'Verify recreated turn retains context',
          steps: [{ step: 1, action: 'Trigger agent_not_found', expected: 'Seamless continuation' }],
        },
      },
    ],
    steerTurn: {
      initialPrompt: 'Draft NFRs for command receipt latency.',
      steerText: 'Use p95 under 500ms for receipts and under 2s for snapshots.',
      preSteerEvents: [
        { type: 'thinking', text: 'Drafting latency NFRs.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Updated NFRs: command receipts p95 < 500ms and thread snapshots p95 < 2000ms.',
      ]),
      expectedSteeredSubstring: '500ms',
    },
    summarize: {
      fullSummaryText:
        'PRD-301 refined PBI-007 recreation criteria and locked latency NFRs at 500ms receipt / 2s snapshot.',
      fullEvents: buildSummarizeEvents(
        'PRD-301 refined PBI-007 recreation criteria and locked latency NFRs at 500ms receipt / 2s snapshot.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_PRD_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_PRD_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Rewrite the entire backlog JSON from scratch.',
      initialEvents: [
        { type: 'thinking', text: 'Rebuilding backlog items.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-prd-v140',
      userPrompt: 'Confirm the owner approval rule for write tools.',
      events: buildSimpleReplyEvents([
        'PRD-301 specifies BR-001: every write tool stages a proposal and waits for explicit user confirmation.',
      ]),
      expectedReplySubstring: 'BR-001',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-prd-assistant',
      priorMessages: [
        {
          role: 'user',
          text: 'Keep PBI-009 scoped to explicit confirmation diffs for PRD-301.',
          timestamp: '2026-11-18T17:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Scoped PBI-009 to explicit confirmation diffs with zero direct mutations.',
          timestamp: '2026-11-18T17:00:15.000Z',
        },
        {
          role: 'user',
          text: 'Mark CAB requests as requiring an explicit dry-run or prod choice.',
          timestamp: '2026-11-18T17:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Added PBI-009 AC-2 requiring dry-run or prod choice before CAB submission.',
          timestamp: '2026-11-18T17:01:10.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'PRD-301 PBI-009 mandates explicit confirmation diffs for every write tool and a dry-run/prod choice for CAB requests.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_PRD_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Add a bullet for read-only viewer rejection under that PBI.',
      anchorFact: 'PBI-009',
      events: buildSimpleReplyEvents([
        'Added PBI-009 AC-3: users without write access receive a 403 rejection on proposal confirmation with no data mutation.',
      ]),
    },
  },

  'design-doc-assistant': {
    area: 'design-doc-assistant',
    context: { kind: 'design-doc', id: 'doc-401' },
    skillPath: '.cursor/skills/prd-design-spec/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'Design Doc 401: Chat Harness Tech Spec',
    normalTurn: {
      userPrompt: 'Document the partial index on chat_thread_summaries.',
      events: buildNormalEvents({
        thinking: 'Checking migration for chat_thread_summaries index name.',
        toolName: 'Read',
        toolTarget: 'migrations/20261119000000_ch01_chat-harness.sql',
        chunks: [
          'Documented `idx_chat_thread_summaries_latest_full` covering ',
          '`(thread_id, created_at DESC) WHERE is_fallback = false`.',
        ],
        usage: {
          inputTokens: 1720,
          outputTokens: 325,
          cacheReadTokens: 780,
          cacheWriteTokens: 90,
        },
      }),
      expectedReplySubstring: 'idx_chat_thread_summaries_latest_full',
      usage: {
        inputTokens: 1720,
        outputTokens: 325,
        cacheReadTokens: 780,
        cacheWriteTokens: 90,
      },
    },
    customToolPayloads: [
      {
        toolName: 'update_design_doc',
        proxyTarget: 'design-doc-assistant/update-design-doc',
        writes: true,
        args: {
          docId: 'doc-401',
          threadId: SAMPLE_THREAD_ID,
          section: 'tech-spec',
          content: '## Index Strategy\nUses partial index for non-fallback summaries.',
        },
      },
    ],
    steerTurn: {
      initialPrompt: 'Explain the maintenance scheduler job.',
      steerText: 'Include the 24-hour command payload purge window.',
      preSteerEvents: [
        { type: 'thinking', text: 'Drafting maintenance scheduler section.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'The maintenance scheduler purges `chat_thread_commands.payload` after 24 hours while preserving dedupe keys.',
      ]),
      expectedSteeredSubstring: '24 hours',
    },
    summarize: {
      fullSummaryText:
        'Design Doc 401 specifies partial indexing on chat_thread_summaries and 24-hour payload purging.',
      fullEvents: buildSummarizeEvents(
        'Design Doc 401 specifies partial indexing on chat_thread_summaries and 24-hour payload purging.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_DESIGN_DOC_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_DESIGN_DOC_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Regenerate every Mermaid diagram in the tech spec.',
      initialEvents: [
        { type: 'thinking', text: 'Regenerating architecture diagrams.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-design-doc-v140',
      userPrompt: 'Confirm the retention period for summary rows.',
      events: buildSimpleReplyEvents([
        'Per Design Doc 401, full summary rows stay retained for active threads while stale command rows prune on schedule.',
      ]),
      expectedReplySubstring: 'Design Doc 401',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-design-doc',
      priorMessages: [
        {
          role: 'user',
          text: 'Design Doc 401 requires a 24,000-char recreation cap.',
          timestamp: '2026-11-18T18:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Documented `DEFAULT_RECREATION_MAX_CHARS = 24_000` in the spec.',
          timestamp: '2026-11-18T18:00:18.000Z',
        },
        {
          role: 'user',
          text: 'Keep fallback summaries excluded from prompt assembly.',
          timestamp: '2026-11-18T18:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Added invariant: `isFallback: true` rows are never injected into `buildRecreationPrompt`.',
          timestamp: '2026-11-18T18:01:12.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Design Doc 401 sets a 24,000-char recreation cap and forbids fallback summaries in recreation prompt assembly.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_DESIGN_DOC_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Add the test verification note for that cap.',
      anchorFact: '24,000-char',
      events: buildSimpleReplyEvents([
        'Verification note: unit tests assert the 24,000-char recreation cap trims older turns while preserving the latest messages.',
      ]),
    },
  },

  'ask-apex': {
    area: 'ask-apex',
    context: null,
    skillPath: '.cursor/skills/app-knowledge/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'Ask Apex product knowledge assistant',
    normalTurn: {
      userPrompt: 'Where do I configure project AI models in Apex?',
      events: buildNormalEvents({
        thinking: 'Checking context.md for Project Settings navigation.',
        toolName: 'Read',
        toolTarget: 'context.md',
        chunks: [
          'Open Project Admin → Project Settings to configure per-lane skills, ',
          'models, and effort levels for your project.',
        ],
        usage: {
          inputTokens: 1310,
          outputTokens: 195,
          cacheReadTokens: 540,
          cacheWriteTokens: 0,
        },
      }),
      expectedReplySubstring: 'Project Admin',
      usage: {
        inputTokens: 1310,
        outputTokens: 195,
        cacheReadTokens: 540,
        cacheWriteTokens: 0,
      },
    },
    customToolPayloads: [],
    steerTurn: {
      initialPrompt: 'Explain RBAC in Apex.',
      steerText: 'Focus only on how project roles override global roles.',
      preSteerEvents: [
        { type: 'thinking', text: 'Looking up RBAC override behavior.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Project-specific roles override a user’s global role within that project.',
      ]),
      expectedSteeredSubstring: 'override',
    },
    summarize: {
      fullSummaryText:
        'Answered how to configure Project Settings lanes and how project RBAC roles override global roles.',
      fullEvents: buildSummarizeEvents(
        'Answered how to configure Project Settings lanes and how project RBAC roles override global roles.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_ASK_APEX_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_ASK_APEX_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Summarize every single feature in context.md.',
      initialEvents: [
        { type: 'thinking', text: 'Reading context.md sections.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-ask-apex-v140',
      userPrompt: 'Do Super Admins bypass menu visibility?',
      events: buildSimpleReplyEvents([
        'Yes — Super Admins bypass menu visibility restrictions across every project.',
      ]),
      expectedReplySubstring: 'Super Admins',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-ask-apex',
      priorMessages: [
        {
          role: 'user',
          text: 'We were looking at the Guided Walkthrough Anchor Management flow.',
          timestamp: '2026-11-18T19:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Anchor Management lives under Platform Admin → Walkthroughs → Anchor Management.',
          timestamp: '2026-11-18T19:00:14.000Z',
        },
        {
          role: 'user',
          text: 'Only approved and active catalog rows are eligible at runtime, right?',
          timestamp: '2026-11-18T19:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Correct — runtime coachmarks resolve strictly against approved+active catalog rows.',
          timestamp: '2026-11-18T19:01:10.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Discussed Guided Walkthrough Anchor Management under Platform Admin and confirmed only approved+active catalog rows resolve at runtime.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_ASK_APEX_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'How do smart tags apply during sync review there?',
      anchorFact: 'Anchor Management',
      events: buildSimpleReplyEvents([
        'In Anchor Management sync review, smart tags apply only to newly discovered pending anchors to suggest route and classification metadata.',
      ]),
    },
  },

  'calendar-work-item': {
    area: 'calendar-work-item',
    context: { kind: 'work-item', id: 'wi-5510' },
    skillPath: '.cursor/skills/calendar-assistant/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'ADO Work Item #5510: Sprint 42 checkout retry',
    normalTurn: {
      userPrompt: 'Draft updated acceptance criteria for ADO work item 5510.',
      events: buildNormalEvents({
        thinking: 'Checking retry logic files to ground AC details.',
        toolName: 'Glob',
        toolTarget: 'src/server/services/*Retry*.ts',
        chunks: [
          'Prepared proposed acceptance criteria for work item #5510 ',
          'covering idempotent retry backoff and dead-letter alerting.',
        ],
        usage: {
          inputTokens: 1490,
          outputTokens: 270,
          cacheReadTokens: 610,
          cacheWriteTokens: 40,
        },
      }),
      expectedReplySubstring: '#5510',
      usage: {
        inputTokens: 1490,
        outputTokens: 270,
        cacheReadTokens: 610,
        cacheWriteTokens: 40,
      },
    },
    customToolPayloads: [
      {
        toolName: 'propose_work_item_changes',
        proxyTarget: 'calendar-assistant/propose-work-item-changes',
        writes: true,
        args: {
          sessionId: 'cal-sess-1',
          threadId: SAMPLE_THREAD_ID,
          changes: [
            {
              field: 'Microsoft.VSTS.Common.AcceptanceCriteria',
              value: 'Retries use exponential backoff up to 3 attempts.',
            },
          ],
        },
      },
    ],
    steerTurn: {
      initialPrompt: 'Propose description edits for work item 5510.',
      steerText: 'Keep the description under three concise bullets.',
      preSteerEvents: [
        { type: 'thinking', text: 'Structuring description diff.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Trimmed work item #5510 description to three concise bullets ready for diff confirmation.',
      ]),
      expectedSteeredSubstring: 'three concise bullets',
    },
    summarize: {
      fullSummaryText:
        'Drafted concise description and acceptance criteria proposals for ADO work item #5510.',
      fullEvents: buildSummarizeEvents(
        'Drafted concise description and acceptance criteria proposals for ADO work item #5510.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_CALENDAR_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_CALENDAR_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Cross-reference every work item in Sprint 42.',
      initialEvents: [
        { type: 'thinking', text: 'Scanning Sprint 42 items.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-calendar-v140',
      userPrompt: 'Did we apply the change yet?',
      events: buildSimpleReplyEvents([
        'No — the work item #5510 diff is staged and waiting for your explicit apply click.',
      ]),
      expectedReplySubstring: 'explicit apply',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-calendar',
      priorMessages: [
        {
          role: 'user',
          text: 'Work item #5510 targets Sprint 42 with dependency on payment-webhook-v2.',
          timestamp: '2026-11-18T20:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Recorded dependency on payment-webhook-v2 for work item #5510.',
          timestamp: '2026-11-18T20:00:12.000Z',
        },
        {
          role: 'user',
          text: 'Flag QA handoff as due Thursday.',
          timestamp: '2026-11-18T20:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Added Thursday QA handoff milestone to #5510 notes.',
          timestamp: '2026-11-18T20:01:14.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Work item #5510 in Sprint 42 depends on payment-webhook-v2 with QA handoff scheduled for Thursday.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_CALENDAR_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Draft the final risk note for that dependency.',
      anchorFact: 'payment-webhook-v2',
      events: buildSimpleReplyEvents([
        'Risk note for #5510: any slip in payment-webhook-v2 directly jeopardizes Thursday QA handoff in Sprint 42.',
      ]),
    },
  },

  'qa-lab': {
    area: 'qa-lab',
    context: { kind: 'qa-suite', id: 'suite-601' },
    skillPath: '.cursor/skills/create-test-case/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'QA Lab Suite suite-601: Chat Harness Regression Pack',
    normalTurn: {
      userPrompt: 'Review coverage gaps in suite-601 for cancel timeout handling.',
      events: buildNormalEvents({
        thinking: 'Inspecting suite-601 cases and cancel timeout logic.',
        toolName: 'Read',
        toolTarget: 'src/server/services/chatHarness/chatHarnessCommandHandler.ts',
        chunks: [
          'Suite-601 covers happy-path cancel, but lacks a case verifying the ',
          '2-second cancel confirmation timeout receipt.',
        ],
        usage: {
          inputTokens: 1560,
          outputTokens: 290,
          cacheReadTokens: 690,
          cacheWriteTokens: 70,
        },
      }),
      expectedReplySubstring: '2-second cancel confirmation timeout',
      usage: {
        inputTokens: 1560,
        outputTokens: 290,
        cacheReadTokens: 690,
        cacheWriteTokens: 70,
      },
    },
    customToolPayloads: [
      {
        toolName: 'qa_lab_list_suites',
        proxyTarget: 'qa-lab/list-suites',
        writes: false,
        args: { threadId: SAMPLE_THREAD_ID },
      },
      {
        toolName: 'qa_lab_get_cases',
        proxyTarget: 'qa-lab/get-cases',
        writes: false,
        args: { threadId: SAMPLE_THREAD_ID, suiteId: 'suite-601' },
      },
      {
        toolName: 'qa_lab_update_case',
        proxyTarget: 'qa-lab/update-case',
        writes: true,
        args: {
          threadId: SAMPLE_THREAD_ID,
          suiteId: 'suite-601',
          localCaseId: 'tc-101',
          patch: { title: 'Verify 2s cancel timeout receipt' },
          reason: 'Align with BR-004 timeout window',
        },
      },
      {
        toolName: 'qa_lab_add_case',
        proxyTarget: 'qa-lab/add-case',
        writes: true,
        args: {
          threadId: SAMPLE_THREAD_ID,
          suiteId: 'suite-601',
          pbiId: 'PBI-005',
          testCase: { title: 'Cancel after turn ended returns applied' },
          reason: 'Cover race condition',
        },
      },
      {
        toolName: 'qa_lab_delete_case',
        proxyTarget: 'qa-lab/delete-case',
        writes: true,
        args: {
          threadId: SAMPLE_THREAD_ID,
          suiteId: 'suite-601',
          localCaseId: 'tc-obsolete',
          reason: 'Duplicate of tc-101',
        },
      },
      {
        toolName: 'qa_lab_comment_case',
        proxyTarget: 'qa-lab/comment-case',
        writes: true,
        args: {
          threadId: SAMPLE_THREAD_ID,
          suiteId: 'suite-601',
          localCaseId: 'tc-101',
          body: 'Confirm expected reason string matches closed catalog.',
          reason: 'QA review note',
        },
      },
      {
        toolName: 'qa_lab_regenerate_case',
        proxyTarget: 'qa-lab/regenerate-case',
        writes: true,
        args: {
          threadId: SAMPLE_THREAD_ID,
          suiteId: 'suite-601',
          localCaseId: 'tc-101',
          reason: 'Incorporate open review comments',
        },
      },
    ],
    steerTurn: {
      initialPrompt: 'Draft negative test cases for suite-601.',
      steerText: 'Prioritize read-only RBAC rejection cases first.',
      preSteerEvents: [
        { type: 'thinking', text: 'Drafting negative QA cases.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Prioritized read-only RBAC rejection case: viewer socket gets rejected receipt and zero DB rows.',
      ]),
      expectedSteeredSubstring: 'read-only RBAC',
    },
    summarize: {
      fullSummaryText:
        'Identified cancel timeout and read-only RBAC coverage gaps in QA suite-601.',
      fullEvents: buildSummarizeEvents(
        'Identified cancel timeout and read-only RBAC coverage gaps in QA suite-601.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_QA_LAB_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_QA_LAB_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Regenerate all 80 test cases in suite-601.',
      initialEvents: [
        { type: 'thinking', text: 'Loading all 80 cases from suite-601.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-qa-lab-v140',
      userPrompt: 'Are read tools auto-approved?',
      events: buildSimpleReplyEvents([
        'Yes — `qa_lab_list_suites` and `qa_lab_get_cases` are read-only, while all five mutation tools require confirmation.',
      ]),
      expectedReplySubstring: 'qa_lab_list_suites',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-qa-lab',
      priorMessages: [
        {
          role: 'user',
          text: 'Tag every P0 security case in suite-601 with release-blocker-r4.',
          timestamp: '2026-11-18T21:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Marked all P0 security test cases in suite-601 for tag release-blocker-r4.',
          timestamp: '2026-11-18T21:00:15.000Z',
        },
        {
          role: 'user',
          text: 'Keep step assertions aligned with Playwright selectors.',
          timestamp: '2026-11-18T21:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Updated test step phrasing to reference stable `data-testid` selectors.',
          timestamp: '2026-11-18T21:01:10.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Suite-601 P0 security cases use tag release-blocker-r4 and stable data-testid Playwright assertions.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_QA_LAB_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Draft one more P0 case for tampered tool grants.',
      anchorFact: 'release-blocker-r4',
      events: buildSimpleReplyEvents([
        'Proposed P0 case (tag: release-blocker-r4): tampered encrypted tool grant returns HTTP 403 before downstream dispatch.',
      ]),
    },
  },

  brainstorm: {
    area: 'brainstorm',
    context: { kind: 'brainstorm-session', id: 'bs-701' },
    skillPath: null,
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'Brainstorm session bs-701: Offline-resilient composer UX',
    normalTurn: {
      userPrompt: 'Explore how to visualize queued follow-up steers in the composer.',
      events: buildNormalEvents({
        thinking: 'Checking existing agentChat components for composer patterns.',
        toolName: 'Glob',
        toolTarget: 'src/client/components/agentChat/*',
        chunks: [
          'A compact chip stack above the input can show accepted vs queued steers ',
          'with inline receipt status badges.',
        ],
        usage: {
          inputTokens: 1580,
          outputTokens: 305,
          cacheReadTokens: 710,
          cacheWriteTokens: 95,
        },
      }),
      expectedReplySubstring: 'chip stack',
      usage: {
        inputTokens: 1580,
        outputTokens: 305,
        cacheReadTokens: 710,
        cacheWriteTokens: 95,
      },
    },
    customToolPayloads: [
      {
        toolName: BRAINSTORM_UPDATE_ARTIFACT_TOOL,
        proxyTarget: 'brainstorm-artifact/update',
        writes: true,
        args: {
          markdown: '# Offline-resilient composer UX\n\n- Chip stack for pending steers\n',
        },
      },
    ],
    steerTurn: {
      initialPrompt: 'Brainstorm three layout options for the activity rail.',
      steerText: 'Drop modal overlays; keep everything inline in the transcript.',
      preSteerEvents: [
        { type: 'thinking', text: 'Comparing layout concepts.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Keeping everything inline in the transcript: collapsible tool-group rows avoid modal overlays completely.',
      ]),
      expectedSteeredSubstring: 'inline in the transcript',
    },
    summarize: {
      fullSummaryText:
        'Explored inline transcript activity rail and pending steer chip stack for Brainstorm session bs-701.',
      fullEvents: buildSummarizeEvents(
        'Explored inline transcript activity rail and pending steer chip stack for Brainstorm session bs-701.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_BRAINSTORM_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_BRAINSTORM_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Write five competing full-page wireframes.',
      initialEvents: [
        { type: 'thinking', text: 'Sketching five wireframe concepts.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-brainstorm-v140',
      userPrompt: 'Who can send messages in a shared brainstorm session?',
      events: buildSimpleReplyEvents([
        'Only the session owner with `brainstorm:create` can issue write commands; collaborators view live frames read-only.',
      ]),
      expectedReplySubstring: 'session owner',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-brainstorm',
      priorMessages: [
        {
          role: 'user',
          text: 'Our core design metaphor is the quiet cockpit layout with zero noisy toasts.',
          timestamp: '2026-11-18T22:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Anchored the artifact around the quiet cockpit layout using subtle inline status pills.',
          timestamp: '2026-11-18T22:00:16.000Z',
        },
        {
          role: 'user',
          text: 'Preserve keyboard-first navigation via Cmd+Enter.',
          timestamp: '2026-11-18T22:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Recorded keyboard shortcut requirement: Cmd+Enter sends or steers without leaving the editor.',
          timestamp: '2026-11-18T22:01:12.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Brainstorm bs-701 centers on the quiet cockpit layout with inline status pills and Cmd+Enter keyboard-first actions.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_BRAINSTORM_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'How should reconnect recovery look inside that layout?',
      anchorFact: 'quiet cockpit layout',
      events: buildSimpleReplyEvents([
        'Inside the quiet cockpit layout, reconnect recovery displays a single calm inline pill ("Reconnecting…") rather than popping toast banners.',
      ]),
    },
  },

  'cab-release': {
    area: 'cab-release',
    context: { kind: 'release', id: 'rel-2026-11' },
    skillPath: '.cursor/skills/cab-release/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'Release Epic rel-2026-11: Platform 2026.11.1',
    normalTurn: {
      userPrompt: 'Prepare the ServiceNow CAB change summary for release 2026.11.1.',
      events: buildNormalEvents({
        thinking: 'Checking CHANGELOG.json and release epic metadata.',
        toolName: 'Read',
        toolTarget: 'public/CHANGELOG.json',
        chunks: [
          'Drafted CAB change summary for release 2026.11.1 covering ',
          'zero-downtime migration verification and rollback steps.',
        ],
        usage: {
          inputTokens: 1610,
          outputTokens: 295,
          cacheReadTokens: 730,
          cacheWriteTokens: 60,
        },
      }),
      expectedReplySubstring: '2026.11.1',
      usage: {
        inputTokens: 1610,
        outputTokens: 295,
        cacheReadTokens: 730,
        cacheWriteTokens: 60,
      },
    },
    customToolPayloads: [
      {
        toolName: 'cab-request',
        proxyTarget: 'cab-release/propose-request',
        writes: true,
        args: {
          targetVersion: '2026.11.1',
          mode: 'dry-run',
          summary: 'CAB change request for release 2026.11.1',
        },
      },
    ],
    steerTurn: {
      initialPrompt: 'Draft the CAB backout plan.',
      steerText: 'Specify Container Apps revision traffic shift as the primary backout.',
      preSteerEvents: [
        { type: 'thinking', text: 'Writing CAB backout plan.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Primary backout: shift Azure Container Apps revision traffic 100% back to the prior healthy revision.',
      ]),
      expectedSteeredSubstring: 'Container Apps revision',
    },
    summarize: {
      fullSummaryText:
        'Prepared CAB release 2026.11.1 summary with Container Apps revision traffic shift backout plan.',
      fullEvents: buildSummarizeEvents(
        'Prepared CAB release 2026.11.1 summary with Container Apps revision traffic shift backout plan.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_CAB_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_CAB_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Audit every commit since January 2026.',
      initialEvents: [
        { type: 'thinking', text: 'Scanning commit history.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-cab-v140',
      userPrompt: 'Has the ServiceNow ticket been submitted?',
      events: buildSimpleReplyEvents([
        'No — the CAB proposal waits for your explicit dry-run or prod selection before submission.',
      ]),
      expectedReplySubstring: 'dry-run or prod',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-cab-release',
      priorMessages: [
        {
          role: 'user',
          text: 'Maintenance window for CHG-2026-11 is Sunday 02:00-04:00 UTC.',
          timestamp: '2026-11-18T23:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Recorded change window Sunday 02:00-04:00 UTC for CHG-2026-11.',
          timestamp: '2026-11-18T23:00:12.000Z',
        },
        {
          role: 'user',
          text: 'Run dry-run validation before proposing prod submission.',
          timestamp: '2026-11-18T23:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Set initial CAB proposal mode to dry-run for CHG-2026-11.',
          timestamp: '2026-11-18T23:01:10.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'CAB change CHG-2026-11 is scheduled for Sunday 02:00-04:00 UTC and starts in dry-run validation mode.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_CAB_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Draft the stakeholder notice for that change.',
      anchorFact: 'CHG-2026-11',
      events: buildSimpleReplyEvents([
        'Stakeholder notice for CHG-2026-11: scheduled for Sunday 02:00-04:00 UTC following dry-run validation with zero expected downtime.',
      ]),
    },
  },

  'build-intake': {
    area: 'build-intake',
    context: { kind: 'build-intake', id: 'bi-801' },
    skillPath: '.cursor/skills/build-intake/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'Build Intake bi-801: Webhook retry dashboard',
    normalTurn: {
      userPrompt: 'Build a webhook retry dashboard for support engineers.',
      events: buildNormalEvents({
        thinking: 'Restating request and checking clarifying questions without repo code access.',
        chunks: [
          'I will scope a webhook retry dashboard for support engineers with ',
          'sensible defaults. Should support engineers retry single events or bulk batches?',
        ],
        usage: {
          inputTokens: 1090,
          outputTokens: 220,
          cacheReadTokens: 280,
          cacheWriteTokens: 50,
        },
      }),
      expectedReplySubstring: 'webhook retry dashboard',
      usage: {
        inputTokens: 1090,
        outputTokens: 220,
        cacheReadTokens: 280,
        cacheWriteTokens: 50,
      },
    },
    customToolPayloads: [],
    steerTurn: {
      initialPrompt: 'Ask intake questions about authentication.',
      steerText: 'Reuse existing Apex SSO; ask only about retry audit fields.',
      preSteerEvents: [
        { type: 'thinking', text: 'Formulating intake question.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        'Noted Apex SSO reuse. For retry audit fields, should we record operator ID and reason note on each replay?',
      ]),
      expectedSteeredSubstring: 'retry audit fields',
    },
    summarize: {
      fullSummaryText:
        'Build intake bi-801 scoped a webhook retry dashboard using Apex SSO with operator audit logging.',
      fullEvents: buildSummarizeEvents(
        'Build intake bi-801 scoped a webhook retry dashboard using Apex SSO with operator audit logging.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_BUILD_INTAKE_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_BUILD_INTAKE_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'List every possible dashboard chart variant.',
      initialEvents: [
        { type: 'thinking', text: 'Listing chart options.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-build-intake-v140',
      userPrompt: 'Yes, include bulk batch retry up to 50 events.',
      events: buildSimpleReplyEvents([
        'Captured bulk retry cap at 50 events per batch. Ready for final confirmation.',
      ]),
      expectedReplySubstring: '50 events',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-build-intake',
      priorMessages: [
        {
          role: 'user',
          text: 'Target system is Billing-Hooks-EU and no PII payloads may be stored.',
          timestamp: '2026-11-18T11:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Recorded target system Billing-Hooks-EU with strict no-PII payload storage.',
          timestamp: '2026-11-18T11:00:10.000Z',
        },
        {
          role: 'user',
          text: 'Retain delivery metadata for 14 days only.',
          timestamp: '2026-11-18T11:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Set metadata retention policy to 14 days.',
          timestamp: '2026-11-18T11:01:08.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Build intake bi-801 targets Billing-Hooks-EU with zero PII storage and 14-day metadata retention.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_BUILD_INTAKE_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Give me the one-line final confirmation summary.',
      anchorFact: 'Billing-Hooks-EU',
      events: buildSimpleReplyEvents([
        'Final confirmation: build a webhook retry dashboard for Billing-Hooks-EU storing zero PII payloads with 14-day metadata retention.',
      ]),
    },
  },

  'standup-participant': {
    area: 'standup-participant',
    context: { kind: 'standup-session', id: 'su-901' },
    skillPath: '.cursor/skills/daily-standup/SKILL.md',
    model: 'claude-sonnet-4-6',
    areaKeyContext: 'Daily Standup su-901: Core Platform Team',
    normalTurn: {
      userPrompt: 'Yesterday I finished S11 cutover tests; today I am finishing S12 contract suite.',
      events: buildNormalEvents({
        thinking: 'Checking git/workspace status read-only if needed and recording standup update.',
        toolName: 'LS',
        toolTarget: 'src/server/__tests__/chatHarness',
        chunks: [
          'Recorded your standup update: completed S11 cutover tests, focusing on ',
          'S12 contract suite today. Any blockers for the team?',
        ],
        usage: {
          inputTokens: 980,
          outputTokens: 175,
          cacheReadTokens: 320,
          cacheWriteTokens: 0,
        },
      }),
      expectedReplySubstring: 'S12 contract suite',
      usage: {
        inputTokens: 980,
        outputTokens: 175,
        cacheReadTokens: 320,
        cacheWriteTokens: 0,
      },
    },
    customToolPayloads: [],
    steerTurn: {
      initialPrompt: 'Format my standup update for leadership.',
      steerText: 'Keep it to two bullets with no jargon.',
      preSteerEvents: [
        { type: 'thinking', text: 'Formatting standup summary.' },
      ],
      postSteerEvents: buildSimpleReplyEvents([
        '- Finished cutover checks.\n- Completing final automated contract checks today; no blockers.',
      ]),
      expectedSteeredSubstring: 'no blockers',
    },
    summarize: {
      fullSummaryText:
        'Participant finished S11 cutover checks, is completing S12 contract tests today, and reported no blockers.',
      fullEvents: buildSummarizeEvents(
        'Participant finished S11 cutover checks, is completing S12 contract tests today, and reported no blockers.',
        false,
      ),
      fallbackSummaryText: 'FALLBACK_TRIMMED_STANDUP_SUMMARY',
      fallbackEvents: buildSummarizeEvents(
        'FALLBACK_TRIMMED_STANDUP_SUMMARY',
        true,
      ),
    },
    cancelTurn: {
      userPrompt: 'Summarize the past 30 days of standups.',
      initialEvents: [
        { type: 'thinking', text: 'Aggregating prior standups.' },
      ],
    },
    resumeTurn: {
      priorCursorAgentId: 'cursor-agent-standup-v140',
      userPrompt: 'Add that k6 load check is also done today.',
      events: buildSimpleReplyEvents([
        'Updated your today plan to include the k6 load check alongside the contract suite.',
      ]),
      expectedReplySubstring: 'k6 load check',
    },
    recreateTurn: {
      priorLegacyCursorAgentId: 'legacy-1-0-37-standup',
      priorMessages: [
        {
          role: 'user',
          text: 'Blocker today is waiting on staging Redis TLS certificate rotation.',
          timestamp: '2026-11-18T13:00:00.000Z',
        },
        {
          role: 'agent',
          text: 'Logged blocker: waiting on staging Redis TLS certificate rotation.',
          timestamp: '2026-11-18T13:00:10.000Z',
        },
        {
          role: 'user',
          text: 'Owner for that unblock is Platform Infra.',
          timestamp: '2026-11-18T13:01:00.000Z',
        },
        {
          role: 'agent',
          text: 'Tagged Platform Infra as the unblock owner.',
          timestamp: '2026-11-18T13:01:08.000Z',
        },
      ],
      priorFullSummary: {
        summaryText:
          'Standup su-901 logged a blocker on staging Redis TLS certificate rotation owned by Platform Infra.',
        coversThroughOrdinal: 2,
        isFallback: false,
      },
      priorFallbackSummary: {
        summaryText: 'FALLBACK_STANDUP_DO_NOT_USE',
        coversThroughOrdinal: 2,
        isFallback: true,
      },
      followUpPrompt: 'Confirm my blocker line before submitting.',
      anchorFact: 'Redis TLS certificate rotation',
      events: buildSimpleReplyEvents([
        'Blocker line ready to submit: blocked on staging Redis TLS certificate rotation (owner: Platform Infra).',
      ]),
    },
  },
};

export function getRecordedAreaFixture(
  area: HarnessAreaId,
): RecordedAreaHarnessFixture {
  return RECORDED_HARNESS_STREAMS[area];
}

export interface CreateRecordedExecutionRunOptions {
  readonly beforeGateEvents?: ReadonlyArray<CursorStreamEvent>;
  readonly waitGate?: Promise<void>;
  readonly onCancel?: () => void;
  readonly usage?: CursorTokenUsage;
}

/**
 * Wraps a recorded SDK stream fixture into a `WorkerCursorExecutionRun` so the
 * real `executeCursorExecutionCore` + `createInteractiveSessionActor` execute
 * against recorded events deterministically without contacting Cursor cloud.
 */
export function createRecordedExecutionRun(
  events: ReadonlyArray<CursorStreamEvent>,
  options: CreateRecordedExecutionRunOptions = {},
): WorkerCursorExecutionRun {
  let cancelled = false;
  let resolveCancelGate: (() => void) | null = null;
  const cancelGate = new Promise<void>((resolve) => {
    resolveCancelGate = resolve;
  });

  return {
    supports: (capability: string) =>
      capability === 'stream' || capability === 'cancel',
    async *stream(): AsyncIterable<CursorStreamEvent> {
      for (const ev of options.beforeGateEvents ?? []) {
        if (cancelled) return;
        yield ev;
      }
      if (options.waitGate) {
        await Promise.race([options.waitGate, cancelGate]);
        if (cancelled) return;
      }
      for (const ev of events) {
        if (cancelled) return;
        yield ev;
      }
    },
    async wait() {
      if (options.waitGate && !cancelled) {
        await Promise.race([options.waitGate, cancelGate]);
      }
      if (cancelled) {
        return { status: 'cancelled' };
      }
      return {
        status: 'finished',
        ...(options.usage ? { usage: options.usage } : {}),
      };
    },
    async cancel() {
      cancelled = true;
      resolveCancelGate?.();
      options.onCancel?.();
    },
  };
}
