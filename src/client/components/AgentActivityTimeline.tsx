import React, { useEffect, useMemo, useState } from 'react';
import type {
  AgentRunEventStatus,
  AgentRunPhase,
  ChatMessage,
  ChatThreadStatus,
} from '../../shared/types/chat';
import type { DevSessionSetupPhase } from '../../shared/types/devWorkbench';
import type {
  RunHealthProgress,
  RunPhaseProgress,
  ToolProgress,
} from '../hooks/useChatStream';
import styles from './AgentActivityTimeline.module.css';

const MAX_EXPANDED_TECHNICAL_EVENTS = 100;
const STALE_PROGRESS_MS = 2 * 60 * 1000;

type PhaseId =
  | 'workspace'
  | 'planning'
  | 'dependencies'
  | 'implementation'
  | 'tests'
  | 'typecheck'
  | 'delivery'
  | 'completion';

type PhaseState = 'complete' | 'current' | 'pending' | 'error';

interface PhaseDefinition {
  id: PhaseId;
  label: string;
}

interface ActivityFact {
  id: string;
  phase: PhaseId;
  timestamp: number;
  label: string;
  isThinking?: boolean;
  semanticStatus?: AgentRunEventStatus;
  durationMs?: number;
}

const PHASES: PhaseDefinition[] = [
  { id: 'workspace', label: 'Workspace preparation' },
  { id: 'planning', label: 'Planning and analysis' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'implementation', label: 'Implementation' },
  { id: 'tests', label: 'Tests' },
  { id: 'typecheck', label: 'Type-check' },
  { id: 'delivery', label: 'Delivery' },
  { id: 'completion', label: 'Complete' },
];

export interface AgentActivityTimelineProps {
  messages: ChatMessage[];
  toolProgress: ToolProgress[];
  phaseEvents?: RunPhaseProgress[];
  runHealth?: RunHealthProgress | null;
  status: ChatThreadStatus;
  isConnected: boolean;
  startedAt?: string | number | null;
  lastProgressAt?: number | null;
  thinkingText?: string;
  isRetrying?: boolean;
  retryReason?: string | null;
  setupPhase?: DevSessionSetupPhase | null;
  setupDetail?: string | null;
  setupProgressAt?: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function classifyTool(
  toolName: string,
  input: Record<string, unknown>
): PhaseId {
  const normalizedName = toolName.toLowerCase();
  const command = stringValue(input.command).toLowerCase();

  if (
    /git\s+push|gh\s+pr|create.?pr|push_branch/.test(
      `${normalizedName} ${command}`
    )
  ) {
    return 'delivery';
  }
  if (
    /(^|\s)(tsc|type-?check|typecheck)(\s|$)/.test(
      `${normalizedName} ${command}`
    )
  ) {
    return 'typecheck';
  }
  if (
    /(^|\s)(test|jest|vitest|playwright|cypress)(\s|$)/.test(
      `${normalizedName} ${command}`
    )
  ) {
    return 'tests';
  }
  if (
    /(npm|pnpm|yarn)\s+(ci|install)|dependencies|bootstrap/.test(
      `${normalizedName} ${command}`
    )
  ) {
    return 'dependencies';
  }
  if (/clone|checkout|workspace|materializ/.test(normalizedName)) {
    return 'workspace';
  }
  if (/read|search|grep|list|task|todo|plan/.test(normalizedName)) {
    return 'planning';
  }
  return 'implementation';
}

function safePath(input: Record<string, unknown>): string {
  const raw = stringValue(
    input.path ?? input.filePath ?? input.file ?? input.target_file
  );
  if (!raw) return '';
  return raw.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
}

function safeToolLabel(
  toolName: string,
  input: Record<string, unknown>
): string {
  const name = toolName.toLowerCase();
  const path = safePath(input);
  if (/read/.test(name)) return path ? `Read ${path}` : 'Read project files';
  if (/search|grep/.test(name)) return 'Searched the codebase';
  if (/list/.test(name))
    return path ? `Listed ${path}` : 'Listed project files';
  if (/edit|replace/.test(name))
    return path ? `Edited ${path}` : 'Edited a file';
  if (/write|create/.test(name)) return path ? `Wrote ${path}` : 'Wrote a file';
  if (/delete/.test(name)) return path ? `Deleted ${path}` : 'Deleted a file';
  if (/terminal|command|shell/.test(name)) return 'Ran a terminal command';
  if (/task/.test(name)) return 'Ran an execution task';
  return toolName ? toolName.replace(/_/g, ' ') : 'Technical activity';
}

function toTimestamp(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return remainingSeconds
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatAgo(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 10_000) return 'just now';
  return `${formatDuration(elapsed)} ago`;
}

function phaseForMessage(message: ChatMessage): PhaseId | null {
  if (message.toolName === '_thinking' || message.toolName === '_reasoning')
    return 'planning';
  if (message.role === 'tool')
    return classifyTool(message.toolName ?? '', message.toolInput ?? {});
  if (message.role === 'agent') return 'completion';
  return null;
}

function semanticPhaseId(phase: AgentRunPhase): PhaseId {
  switch (phase) {
    case 'setup':
      return 'workspace';
    case 'planning':
    case 'approval':
    case 'analysis':
      return 'planning';
    case 'dependencies':
      return 'dependencies';
    case 'implementation':
      return 'implementation';
    case 'testing':
      return 'tests';
    case 'typecheck':
      return 'typecheck';
    case 'push':
      return 'delivery';
    case 'completion':
      return 'completion';
  }
}

function buildFacts(
  messages: ChatMessage[],
  toolProgress: ToolProgress[],
  phaseEvents: RunPhaseProgress[],
  thinkingText: string,
  now: number,
  setup?: {
    phase: DevSessionSetupPhase;
    detail?: string | null;
    timestamp?: string | null;
  }
): { facts: ActivityFact[]; thinkingCount: number } {
  const facts: ActivityFact[] = [];
  let thinkingCount = 0;
  let firstThinkingAt: number | null = null;

  for (const message of messages) {
    const phase = phaseForMessage(message);
    if (!phase) continue;
    const timestamp = toTimestamp(message.ts) ?? now;
    const isThinking =
      message.toolName === '_thinking' || message.toolName === '_reasoning';
    if (isThinking) {
      thinkingCount += 1;
      firstThinkingAt =
        firstThinkingAt === null
          ? timestamp
          : Math.min(firstThinkingAt, timestamp);
      continue;
    }
    facts.push({
      id: message.id,
      phase,
      timestamp,
      label:
        message.role === 'agent'
          ? 'Agent response completed'
          : safeToolLabel(message.toolName ?? '', message.toolInput ?? {}),
    });
  }

  if (thinkingCount > 0 || thinkingText) {
    facts.push({
      id: 'analysis-summary',
      phase: 'planning',
      timestamp: firstThinkingAt ?? now,
      label:
        thinkingCount > 0
          ? `Analysis activity (${thinkingCount} fragments)`
          : 'Analyzing',
      isThinking: true,
    });
  }

  for (const progress of toolProgress) {
    const input = asRecord(progress.args);
    facts.push({
      id: `live-${progress.callId}`,
      phase: classifyTool(progress.toolName, input),
      timestamp: progress.ts,
      label: safeToolLabel(progress.toolName, input),
    });
  }

  if (setup) {
    facts.push({
      id: `setup-${setup.phase}`,
      phase: 'dependencies',
      timestamp: toTimestamp(setup.timestamp) ?? now,
      label:
        setup.detail?.replace(/\s+/g, ' ').trim().slice(0, 500) ||
        setup.phase.replace(/_/g, ' '),
      semanticStatus:
        setup.phase === 'dependencies_failed'
          ? 'failed'
          : setup.phase === 'dependencies_ready' ||
              setup.phase === 'dependencies_skipped'
            ? 'completed'
            : 'running',
    });
  }

  for (const event of phaseEvents) {
    facts.push({
      id: event.id,
      phase: semanticPhaseId(event.phase),
      timestamp: event.timestamp,
      label: event.detail ?? event.phase.replace(/_/g, ' '),
      semanticStatus: event.status,
      durationMs: event.durationMs,
    });
  }

  facts.sort((a, b) => a.timestamp - b.timestamp);
  return { facts, thinkingCount };
}

export const AgentActivityTimeline: React.FC<AgentActivityTimelineProps> = ({
  messages,
  toolProgress,
  phaseEvents = [],
  runHealth = null,
  status,
  isConnected,
  startedAt,
  lastProgressAt = null,
  thinkingText = '',
  isRetrying = false,
  retryReason = null,
  setupPhase = null,
  setupDetail = null,
  setupProgressAt = null,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const isRunning = status === 'running';

  useEffect(() => {
    if (!isRunning) return;
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, [isRunning]);

  const { facts } = useMemo(
    () =>
      buildFacts(
        messages,
        toolProgress,
        phaseEvents,
        thinkingText,
        now,
        setupPhase
          ? {
              phase: setupPhase,
              detail: setupDetail,
              timestamp: setupProgressAt,
            }
          : undefined
      ),
    [
      messages,
      toolProgress,
      phaseEvents,
      thinkingText,
      now,
      setupPhase,
      setupDetail,
      setupProgressAt,
    ]
  );

  const observedByPhase = useMemo(() => {
    const byPhase = new Map<PhaseId, ActivityFact[]>();
    for (const fact of facts) {
      const phaseFacts = byPhase.get(fact.phase) ?? [];
      phaseFacts.push(fact);
      byPhase.set(fact.phase, phaseFacts);
    }
    return byPhase;
  }, [facts]);

  const currentPhaseIndex = useMemo(() => {
    if (!isRunning || facts.length === 0) return -1;
    const semanticCurrent = [...facts]
      .reverse()
      .find((fact) => fact.semanticStatus === 'running');
    if (semanticCurrent)
      return PHASES.findIndex((phase) => phase.id === semanticCurrent.phase);
    return Math.max(
      ...facts.map((fact) =>
        PHASES.findIndex((phase) => phase.id === fact.phase)
      )
    );
  }, [facts, isRunning]);

  const startTimestamp = toTimestamp(startedAt) ?? facts[0]?.timestamp ?? null;
  const endTimestamp = isRunning
    ? now
    : (facts[facts.length - 1]?.timestamp ?? now);
  const elapsed =
    startTimestamp === null ? null : Math.max(0, endTimestamp - startTimestamp);
  const progressBaseline =
    lastProgressAt ?? (isRunning ? startTimestamp : null);
  const staleFor =
    progressBaseline === null ? 0 : Math.max(0, now - progressBaseline);
  const isStale = isRunning && staleFor >= STALE_PROGRESS_MS;

  const analysisFact = facts.find((fact) => fact.isThinking);
  const nonAnalysisFacts = facts.filter((fact) => !fact.isThinking);
  const technicalEvents = analysisFact
    ? [
        analysisFact,
        ...nonAnalysisFacts.slice(-(MAX_EXPANDED_TECHNICAL_EVENTS - 1)),
      ]
    : nonAnalysisFacts.slice(-MAX_EXPANDED_TECHNICAL_EVENTS);
  const hiddenTechnicalCount = Math.max(
    0,
    facts.length - technicalEvents.length
  );

  if (facts.length === 0 && !isRunning && !isRetrying && !runHealth)
    return null;

  const healthNeedsAttention =
    runHealth &&
    ['worker_lost', 'hard_timeout', 'never_claimed'].includes(runHealth.health);
  const sessionLabel =
    status === 'error' || healthNeedsAttention
      ? 'Needs attention'
      : isRetrying
        ? 'Retrying'
        : isRunning
          ? 'Running'
          : 'Complete';

  return (
    <section className={styles.timeline} aria-label="Agent activity">
      <div className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <span
              className={`${styles.runDot} ${isRunning ? styles.runDotActive : ''}`}
              aria-hidden="true"
            />
            <strong className={styles.title}>{sessionLabel}</strong>
            {elapsed !== null && (
              <span className={styles.elapsed}>
                Elapsed {formatDuration(elapsed)}
              </span>
            )}
          </div>
          <div className={styles.meta}>
            <span
              className={isConnected ? styles.connected : styles.reconnecting}
            >
              {isConnected ? 'Connected' : 'Reconnecting'}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {lastProgressAt
                ? `Last progress ${formatAgo(lastProgressAt, now)}`
                : 'Waiting for progress'}
            </span>
          </div>
        </div>
      </div>

      {(isRetrying ||
        isStale ||
        (runHealth && runHealth.health !== 'healthy')) && (
        <div
          className={isRetrying ? styles.retry : styles.warning}
          role="status"
        >
          {isRetrying
            ? (retryReason ??
              'The agent is retrying after a temporary interruption.')
            : runHealth && runHealth.health !== 'healthy'
              ? runHealth.detail
              : `No meaningful progress for ${formatDuration(staleFor)}. The agent may still be working.`}
        </div>
      )}

      {facts.length === 0 && isRunning && (
        <div className={styles.waiting}>Waiting for agent activity</div>
      )}

      <ol className={styles.phases}>
        {PHASES.map((phase, index) => {
          const phaseFacts = observedByPhase.get(phase.id) ?? [];
          const isObserved = phaseFacts.length > 0;
          const latestSemantic = [...phaseFacts]
            .reverse()
            .find((fact) => fact.semanticStatus);
          let phaseState: PhaseState = 'pending';
          if (
            latestSemantic?.semanticStatus === 'failed' ||
            latestSemantic?.semanticStatus === 'cancelled'
          ) {
            phaseState = 'error';
          } else if (latestSemantic?.semanticStatus === 'running') {
            phaseState = 'current';
          } else if (latestSemantic?.semanticStatus === 'completed') {
            phaseState = 'complete';
          } else if (status === 'error' && index === currentPhaseIndex)
            phaseState = 'error';
          else if (isRunning && index === currentPhaseIndex)
            phaseState = 'current';
          else if (isObserved) phaseState = 'complete';

          const phaseStartedAt = phaseFacts[0]?.timestamp;
          const nextObserved = PHASES.slice(index + 1)
            .flatMap((nextPhase) => observedByPhase.get(nextPhase.id) ?? [])
            .sort((a, b) => a.timestamp - b.timestamp)[0]?.timestamp;
          const phaseEndedAt =
            phaseState === 'current'
              ? now
              : (nextObserved ?? phaseFacts[phaseFacts.length - 1]?.timestamp);
          const duration =
            latestSemantic?.durationMs ??
            (phaseStartedAt === undefined || phaseEndedAt === undefined
              ? null
              : Math.max(0, phaseEndedAt - phaseStartedAt));

          return (
            <li key={phase.id} className={styles.phase} data-state={phaseState}>
              <span
                className={`${styles.phaseMarker} ${styles[phaseState]}`}
                aria-hidden="true"
              >
                {phaseState === 'complete'
                  ? '✓'
                  : phaseState === 'current'
                    ? '●'
                    : phaseState === 'error'
                      ? '!'
                      : '○'}
              </span>
              <span className={styles.phaseLabel}>
                <span>{phase.label}</span>
                {latestSemantic?.label && (
                  <small className={styles.phaseDetail}>
                    {latestSemantic.label}
                  </small>
                )}
              </span>
              {duration !== null && (
                <span className={styles.phaseDuration}>
                  {formatDuration(duration)}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {facts.length > 0 && (
        <div className={styles.technical}>
          <button
            type="button"
            className={styles.technicalToggle}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span aria-hidden="true">{expanded ? '▼' : '▶'}</span>
            {expanded ? 'Hide' : 'Show'} {facts.length} technical event
            {facts.length === 1 ? '' : 's'}
          </button>
          {expanded && (
            <div
              className={styles.technicalBody}
              data-testid="technical-events"
            >
              {hiddenTechnicalCount > 0 && (
                <div className={styles.limitNote}>
                  Showing latest {technicalEvents.length} of {facts.length}{' '}
                  events
                </div>
              )}
              <ol className={styles.technicalList}>
                {technicalEvents.map((fact) => (
                  <li key={fact.id} className={styles.technicalEvent}>
                    <span>{fact.label}</span>
                    <time dateTime={new Date(fact.timestamp).toISOString()}>
                      {new Date(fact.timestamp).toLocaleTimeString()}
                    </time>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
