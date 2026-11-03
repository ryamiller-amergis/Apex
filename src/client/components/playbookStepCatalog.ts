/**
 * Presentation metadata for Playbook step types: the name a person reads, a one-line purpose, an
 * icon, and a library group.
 *
 * The server registry decides which step types exist. A type missing here still renders, under its
 * raw name in the "Other" group, so a new server step never disappears from the library.
 */
import {
  Bell,
  Bot,
  Box,
  FileInput,
  GitBranch,
  MessagesSquare,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { PlaybookGraph, PlaybookGraphNode } from '../../shared/types/playbook';

export type PlaybookStepGroup = 'AI' | 'People' | 'Logic' | 'Messaging' | 'Data' | 'Other';

export interface PlaybookStepMeta {
  stepType: string;
  title: string;
  description: string;
  group: PlaybookStepGroup;
  icon: LucideIcon;
}

export const PLAYBOOK_STEP_GROUP_ORDER: readonly PlaybookStepGroup[] = [
  'AI',
  'People',
  'Logic',
  'Messaging',
  'Data',
  'Other',
];

/** Shown as "Most used" before the author has added anything. */
export const DEFAULT_POPULAR_STEP_TYPES: readonly string[] = ['cursor-agent', 'approval-gate', 'notify'];

const KNOWN_STEPS: Record<string, Omit<PlaybookStepMeta, 'stepType'>> = {
  'cursor-agent': {
    title: 'Agent task',
    description: 'Hand a prompt to a Cursor agent and wait for its result.',
    group: 'AI',
    icon: Bot,
  },
  interview: {
    title: 'Interview',
    description: 'Run a requirements interview and wait for the approved brief.',
    group: 'People',
    icon: MessagesSquare,
  },
  'approval-gate': {
    title: 'Approval',
    description: 'Pause the run until a person approves or rejects.',
    group: 'People',
    icon: ShieldCheck,
  },
  branch: {
    title: 'Branch',
    description: "Choose the next step from an earlier step's output.",
    group: 'Logic',
    icon: GitBranch,
  },
  notify: {
    title: 'Notify',
    description: 'Send an in-app notification to the initiator or a named user.',
    group: 'Messaging',
    icon: Bell,
  },
  'ingest-artifact': {
    title: 'Ingest artifact',
    description: "Apply an agent's scorecard to a PRD or design doc.",
    group: 'Data',
    icon: FileInput,
  },
};

export function stepMeta(stepType: string): PlaybookStepMeta {
  const known = KNOWN_STEPS[stepType];
  if (known) return { stepType, ...known };
  return {
    stepType,
    title: stepType,
    description: 'Custom step type.',
    group: 'Other',
    icon: Box,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const INTERVIEW_MODE_LABELS: Record<string, string> = {
  human_led: 'Human-led interview',
  multi_agent_assisted: 'Multi-agent assisted interview',
};

/** Ids the canvas used to generate (`step-<uuid>`) mean nothing to a reader. */
const GENERATED_ID = /^step-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most telling config value for a node, for its second line on the canvas. */
export function nodeSummary(node: Pick<PlaybookGraphNode, 'config'>): string {
  const config = node.config ?? {};
  for (const key of ['title', 'subject', 'prompt', 'profileKey', 'skillPath', 'documentType']) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return truncate(value.trim(), 44);
  }
  if (typeof config.mode === 'string' && INTERVIEW_MODE_LABELS[config.mode]) {
    return INTERVIEW_MODE_LABELS[config.mode];
  }
  return '';
}

/** Second line for a node: its summary, else a readable id, else a prompt to configure it. */
export function nodeSubtitle(node: Pick<PlaybookGraphNode, 'id' | 'config'>): string {
  const summary = nodeSummary(node);
  if (summary) return summary;
  return GENERATED_ID.test(node.id) ? 'Not configured yet' : node.id;
}

/** Nodes in run order: entry nodes first, then each node after everything that leads to it. */
export function orderedSteps(graph: PlaybookGraph): PlaybookGraphNode[] {
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const queue = graph.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const ordered: PlaybookGraphNode[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(byId.get(id)!);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  for (const node of graph.nodes) {
    if (!seen.has(node.id)) ordered.push(node);
  }
  return ordered;
}
