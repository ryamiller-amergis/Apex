import { v4 as uuidv4 } from 'uuid';
import type {
  AgentRunEventEnvelope,
  AgentRunEventStatus,
  AgentRunEventType,
  AgentRunPhase,
  SseEvent,
  SsePhaseEvent,
} from '../../shared/types/chat';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';

export type CursorAssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name: string; input?: unknown };

export type CursorStreamEvent =
  | {
      type: 'assistant';
      message: { content: CursorAssistantBlock[] };
    }
  | { type: 'thinking'; thinking_duration_ms?: number }
  | {
      type: 'tool_call';
      name?: string;
      call_id?: string;
      status?: string;
      args?: unknown;
      result?: unknown;
    }
  | { type: string; [key: string]: unknown };

/**
 * Token counts as reported by the Cursor runtime (`@cursor/sdk` `TokenUsage`).
 * Structural rather than an SDK import so the worker/actor hosts stay decoupled.
 */
export interface CursorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Fields a worker may attach to a terminal ingest when the runtime reported usage. */
export function tokenFieldsForTerminalIngest(
  usage: CursorTokenUsage | undefined,
): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
} {
  if (!usage) return {};
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

function readTokenUsage(value: unknown): CursorTokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const num = (key: string): number => (typeof raw[key] === 'number' && Number.isFinite(raw[key] as number)
    ? Math.max(0, raw[key] as number)
    : 0);
  const usage: CursorTokenUsage = {
    inputTokens: num('inputTokens'),
    outputTokens: num('outputTokens'),
    cacheReadTokens: num('cacheReadTokens'),
    cacheWriteTokens: num('cacheWriteTokens'),
  };
  // A turn that reported nothing is indistinguishable from an all-zero payload;
  // treat both as "no usage" so the caller can fall back to its estimate.
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return total > 0 ? usage : undefined;
}

function addTokenUsage(
  a: CursorTokenUsage | undefined,
  b: CursorTokenUsage | undefined,
): CursorTokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export interface CursorExecutionWaitResult {
  status: string;
  result?: string;
  /** Cumulative usage across turns; absent when the runtime reported none. */
  usage?: unknown;
}

export class CursorExecutionWaitError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly usage?: CursorTokenUsage,
  ) {
    super(cause instanceof Error ? cause.message : 'Cursor run wait failed');
    this.name = 'CursorExecutionWaitError';
  }
}

/**
 * Minimal structural contract shared by the in-process Cursor SDK adapter and
 * the background worker host. Keeping SDK construction outside this module
 * lets the worker open only its frozen, ready workspace.
 */
export interface CursorExecutionRun {
  supports(capability: string): boolean;
  stream(): AsyncIterable<CursorStreamEvent>;
  wait(): Promise<CursorExecutionWaitResult>;
}

export interface CursorExecutionEventSink {
  publish(event: SseEvent, envelope: AgentRunEventEnvelope): Promise<void> | void;
}

export interface CursorExecutionHooks {
  beforeStreamEvent?(): Promise<void> | void;
  onFirstStreamEvent?(): Promise<void> | void;
  onStreamComplete?(): Promise<void> | void;
  onReasoningSegment?(text: string): Promise<void> | void;
  onToolUse?(input: {
    key: string;
    name: string;
    args: unknown;
    phase: AgentRunPhase;
  }): Promise<void> | void;
  onToolUsePublished?(input: {
    key: string;
    name: string;
    args: unknown;
    phase: AgentRunPhase;
  }): Promise<void> | void;
  onThinkingProgress?(input: {
    firstFragment: boolean;
    durationMs?: number;
  }): Promise<void> | void;
  onToolStatus?(input: {
    key: string;
    callId?: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    args: unknown;
    result: unknown;
    phase: AgentRunPhase;
  }): Promise<void> | void;
  onHeartbeat?(): Promise<void> | void;
}

export class ThinkingPhaseCoalescer {
  private startedAt: number | null = null;
  private reportedDurationMs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  observe(fragment: { text?: string; durationMs?: number }): boolean {
    const isFirstFragment = this.startedAt === null;
    if (isFirstFragment) this.startedAt = this.now();
    if (typeof fragment.durationMs === 'number') {
      this.reportedDurationMs = Math.max(this.reportedDurationMs, fragment.durationMs);
    }
    return isFirstFragment;
  }

  flush(at = this.now()): SsePhaseEvent | null {
    if (this.startedAt === null) return null;
    const durationMs = Math.max(0, at - this.startedAt, this.reportedDurationMs);
    this.startedAt = null;
    this.reportedDurationMs = 0;
    return {
      type: 'phase',
      phase: 'analysis',
      status: 'completed',
      detail: 'Analysis completed',
      durationMs,
    };
  }
}

function inferRunEventType(event: SseEvent): AgentRunEventType {
  if (event.type === 'tool_call' || event.type === 'tool_status') return 'tool';
  if (event.type === 'thinking') return 'phase';
  return event.type;
}

function inferRunEventPhase(event: SseEvent): AgentRunPhase {
  if (event.type === 'phase') return event.phase;
  if (event.type === 'health' || event.type === 'done') return 'completion';
  if (event.type === 'tool_call' || event.type === 'tool_status') {
    const toolName = event.toolName.toLowerCase();
    if (/test|jest|vitest|playwright/.test(toolName)) return 'testing';
    if (/type.?check|tsc/.test(toolName)) return 'typecheck';
    if (/push|git/.test(toolName)) return 'push';
  }
  if (event.type === 'thinking') return 'analysis';
  return 'implementation';
}

function inferRunEventStatus(event: SseEvent): AgentRunEventStatus {
  if (event.type === 'phase') return event.status;
  if (event.type === 'health') {
    return event.health === 'worker_lost'
      || event.health === 'hard_timeout'
      || event.health === 'never_claimed'
      || event.health === 'progress_timeout'
      ? 'failed'
      : 'running';
  }
  if (event.type === 'error') return 'failed';
  if (event.type === 'done') return 'completed';
  if (event.type === 'status') return event.status === 'running' ? 'running' : 'completed';
  if (event.type === 'tool_status') {
    return event.status === 'error'
      ? 'failed'
      : event.status === 'completed'
        ? 'completed'
        : 'running';
  }
  return 'running';
}

const TERMINAL_DETAIL_MAX_CHARS = 2_000;

export function sanitizeCursorTerminalDetail(detail: string): string {
  const normalizedControls = [...detail]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 ? ' ' : character;
    })
    .join('');
  return normalizedControls
    .replace(
      /\b(?:postgres(?:ql)?|mongodb(?:\+srv)?|mysql|redis):\/\/\S+/gi,
      '[redacted-connection-string]',
    )
    .replace(
      /\b(?:Server|Data Source|Host)=[^;\s]+;(?:[^;\r\n]+;){1,10}/gi,
      '[redacted-connection-string]',
    )
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\b(token|password|passwd|secret|credential|api[_-]?key|connection[_-]?string)\s*[=:]\s*[^\s;]+/gi,
      '$1=[redacted]',
    )
    .replace(/:\/\/[^/\s@:]+:[^/\s@]+@/g, '://[redacted]@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TERMINAL_DETAIL_MAX_CHARS);
}

function inferRunEventDetail(event: SseEvent): string | undefined {
  let detail: string | undefined;
  if (event.type === 'phase' || event.type === 'health') detail = event.detail;
  else if (event.type === 'tool_call' || event.type === 'tool_status') {
    const nestedSource = event.type === 'tool_status' ? event.args : event.input;
    const nestedName = nestedSource
      && typeof nestedSource === 'object'
      && !Array.isArray(nestedSource)
      && typeof (nestedSource as Record<string, unknown>).toolName === 'string'
      ? String((nestedSource as Record<string, unknown>).toolName)
      : undefined;
    const label = nestedName ? `${event.toolName}:${nestedName}` : event.toolName;
    detail = `${label} ${event.type === 'tool_status' ? event.status : 'started'}`;
  } else if (event.type === 'error') detail = event.error;
  else if (event.type === 'retrying') {
    detail = `Retrying (${event.attempt}/${event.maxAttempts})`;
  } else if (event.type === 'done') detail = 'Run completed';
  if (!detail) return undefined;
  if (event.type === 'error') return sanitizeCursorTerminalDetail(detail);
  return detail.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function createCursorRunEventEnvelope(input: {
  eventId?: string;
  threadId: string;
  runId: string;
  sourceInstance: string;
  sequence: number;
  timestamp?: string;
  event: SseEvent;
  phase?: AgentRunPhase;
}): AgentRunEventEnvelope {
  return {
    eventId: input.eventId ?? uuidv4(),
    threadId: input.threadId,
    runId: input.runId,
    sourceInstance: input.sourceInstance,
    sequence: input.sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: inferRunEventType(input.event),
    phase: input.phase ?? inferRunEventPhase(input.event),
    status: inferRunEventStatus(input.event),
    detail: inferRunEventDetail(input.event),
    event: input.event,
  };
}

export function summarizeCursorToolInput(input: unknown): unknown {
  if (input === null || input === undefined) return undefined;
  if (Array.isArray(input)) return { itemCount: input.length };
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (typeof obj.toolName === 'string' || typeof obj.providerIdentifier === 'string') {
      return {
        ...(typeof obj.providerIdentifier === 'string'
          ? { providerIdentifier: obj.providerIdentifier.slice(0, 120) }
          : {}),
        ...(typeof obj.toolName === 'string' ? { toolName: obj.toolName.slice(0, 120) } : {}),
        args: summarizeCursorToolInput(obj.args),
      };
    }
    return { keys: Object.keys(obj).slice(0, 20) };
  }
  return { type: typeof input };
}

function summarizeCursorToolResult(result: unknown): string | undefined {
  if (typeof result !== 'string') return undefined;
  return result.length === 0
    ? 'Completed with no output'
    : `Completed with ${result.length} characters of output`;
}

export function inferCursorToolPhase(toolName: string, input: unknown): AgentRunPhase {
  const diagnostic = `${toolName} ${JSON.stringify(input ?? '')}`.toLowerCase();
  if (/\b(npm ci|npm install|pnpm install|yarn install)\b/.test(diagnostic)) {
    return 'dependencies';
  }
  if (/\b(jest|vitest|playwright|pytest|dotnet test|npm test)\b/.test(diagnostic)) {
    return 'testing';
  }
  if (/\b(tsc|typecheck|type-check)\b/.test(diagnostic)) return 'typecheck';
  if (/\bgit\s+push\b/.test(diagnostic)) return 'push';
  return 'implementation';
}

export interface ExecuteCursorExecutionCoreInput {
  snapshot: Readonly<ExecutionSnapshot>;
  run: CursorExecutionRun;
  context: {
    runId: string;
    sourceInstance: string;
  };
  sink: CursorExecutionEventSink;
  hooks?: CursorExecutionHooks;
  thinkingPhase?: ThinkingPhaseCoalescer;
  nextSequence: () => number;
  createEventId?: () => string;
  now?: () => string;
}

export interface CursorExecutionResult {
  text: string;
  waitResult: CursorExecutionWaitResult;
  /**
   * Real token counts from the runtime, covering the full prompt the model saw
   * (system prompt, skill, grounding, history, tool output). Absent when the
   * runtime reported no usage — callers should fall back to an estimate.
   */
  usage?: CursorTokenUsage;
}

/**
 * Execute one Cursor run attempt from an immutable snapshot and normalize all
 * SDK stream output into Apex's existing durable/SSE event vocabulary.
 *
 * The core intentionally owns no database, SSE, workspace, or SDK-agent
 * lifecycle concerns. Hosts provide those through the sink and hooks.
 */
export async function executeCursorExecutionCore(
  input: ExecuteCursorExecutionCoreInput,
): Promise<CursorExecutionResult> {
  const {
    snapshot,
    run,
    context,
    sink,
    hooks = {},
    nextSequence,
    createEventId = uuidv4,
    now = () => new Date().toISOString(),
  } = input;
  const thinkingPhase = input.thinkingPhase ?? new ThinkingPhaseCoalescer();
  let textBuffer = '';
  let firstStreamEventSeen = false;
  let anonymousToolUseCount = 0;
  let streamedUsage: CursorTokenUsage | undefined;

  const publish = async (event: SseEvent, phase?: AgentRunPhase): Promise<void> => {
    const envelope = createCursorRunEventEnvelope({
      eventId: createEventId(),
      threadId: snapshot.threadId,
      runId: context.runId,
      sourceInstance: context.sourceInstance,
      sequence: nextSequence(),
      timestamp: now(),
      event,
      phase,
    });
    await sink.publish(event, envelope);
  };

  const flushThinkingPhase = async (): Promise<void> => {
    const phaseEvent = thinkingPhase.flush();
    if (phaseEvent) await publish(phaseEvent);
  };

  if (run.supports('stream')) {
    for await (const event of run.stream()) {
      await hooks.beforeStreamEvent?.();
      if (!firstStreamEventSeen) {
        firstStreamEventSeen = true;
        await hooks.onFirstStreamEvent?.();
      }

      if (event.type === 'assistant') {
        const assistantEvent = event as {
          type: 'assistant';
          message: { content: CursorAssistantBlock[] };
        };
        for (const block of assistantEvent.message.content) {
          if (block.type === 'text') {
            await flushThinkingPhase();
            textBuffer += block.text;
            for (const textChunk of block.text.match(/[\s\S]{1,3000}/g) ?? []) {
              await publish({ type: 'token', text: textChunk });
            }
            await hooks.onHeartbeat?.();
          } else if (block.type === 'tool_use') {
            await flushThinkingPhase();
            if (textBuffer.trim()) {
              await hooks.onReasoningSegment?.(textBuffer.trim());
              textBuffer = '';
            }
            const key = typeof block.id === 'string'
              ? block.id
              : `tool_use:${block.name}:${anonymousToolUseCount++}`;
            const phase = inferCursorToolPhase(block.name, block.input);
            await hooks.onToolUse?.({
              key,
              name: block.name,
              args: block.input,
              phase,
            });
            await publish({
              type: 'tool_call',
              toolName: block.name,
              input: summarizeCursorToolInput(block.input),
            }, phase);
            await hooks.onToolUsePublished?.({
              key,
              name: block.name,
              args: block.input,
              phase,
            });
            await hooks.onHeartbeat?.();
          }
        }
      } else if (event.type === 'thinking') {
        const thinkingEvent = event as {
          type: 'thinking';
          thinking_duration_ms?: number;
        };
        const firstFragment = thinkingPhase.observe({
          durationMs: thinkingEvent.thinking_duration_ms,
        });
        await hooks.onThinkingProgress?.({
          firstFragment,
          durationMs: thinkingEvent.thinking_duration_ms,
        });
        if (firstFragment) {
          await publish({ type: 'thinking', text: 'Analyzing' });
        }
        await hooks.onHeartbeat?.();
      } else if (event.type === 'tool_call') {
        const toolCallEvent = event as {
          type: 'tool_call';
          name?: string;
          call_id?: string;
          status?: string;
          args?: unknown;
          result?: unknown;
        };
        await flushThinkingPhase();
        const status: 'running' | 'completed' | 'error' =
          toolCallEvent.status === 'completed' || toolCallEvent.status === 'error'
            ? toolCallEvent.status
            : 'running';
        const name = toolCallEvent.name ?? '';
        const key = toolCallEvent.call_id || toolCallEvent.name || 'unknown';
        const phase = inferCursorToolPhase(name, toolCallEvent.args);
        await hooks.onToolStatus?.({
          key,
          callId: toolCallEvent.call_id,
          name,
          status,
          args: toolCallEvent.args,
          result: toolCallEvent.result,
          phase,
        });
        await publish({
          type: 'tool_status',
          toolName: name,
          callId: toolCallEvent.call_id ?? '',
          status,
          args: summarizeCursorToolInput(toolCallEvent.args),
          result: summarizeCursorToolResult(toolCallEvent.result),
        }, phase);
        await hooks.onHeartbeat?.();
      } else if (event.type === 'usage') {
        // Emitted once per turn at turn end. Summing turns gives the run total
        // when `wait()` does not carry a cumulative snapshot.
        streamedUsage = addTokenUsage(
          streamedUsage,
          readTokenUsage((event as { usage?: unknown }).usage),
        );
      }
    }
    await hooks.onStreamComplete?.();
  }

  await flushThinkingPhase();
  let waitResult: CursorExecutionWaitResult;
  try {
    waitResult = await run.wait();
  } catch (error) {
    throw new CursorExecutionWaitError(error, streamedUsage);
  }
  return {
    text: textBuffer,
    waitResult,
    // `wait()` reports cumulative usage for the whole run; the summed stream
    // events are the fallback for runtimes that only emit per-turn events.
    usage: readTokenUsage(waitResult.usage) ?? streamedUsage,
  };
}
