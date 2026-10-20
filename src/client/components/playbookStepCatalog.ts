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
  GraduationCap,
  ListChecks,
  MessagesSquare,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { PlaybookGraph, PlaybookGraphNode } from '../../shared/types/playbook';

export type PlaybookStepGroup = 'AI' | 'People' | 'Logic' | 'Messaging' | 'Data' | 'Other';

/** Step types an author may select as AI sources. Display metadata, not the registry. */
export const AI_SOURCE_STEP_TYPES = new Set(['cursor-agent', 'board-deliberation']);

/** Step types an author may select as a human review. */
export const HUMAN_REVIEW_STEP_TYPES = new Set(['approval-gate', 'feedback-review']);

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
  'board-deliberation': {
    title: 'Board deliberation',
    description: 'Run a bounded specialist discussion and preserve its decision audit.',
    group: 'AI',
    icon: MessagesSquare,
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
  'capture-outcome-feedback': {
    title: 'Learn from outcome',
    description: 'Store how people resolved earlier AI work, without saving every prompt.',
    group: 'Data',
    icon: GraduationCap,
  },
  'feedback-review': {
    title: 'Feedback review',
    description: 'Pause so a person can accept, question, or override selected AI work.',
    group: 'People',
    icon: ListChecks,
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
  for (const key of ['label', 'title', 'subject', 'prompt', 'profileKey', 'skillPath', 'documentType']) {
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

export interface PlaybookStepOutline {
  summary: string;
  /** Extra lines revealed by the dashboard step control. Empty when the summary already says it all. */
  details: string[];
}

function configString(
  config: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function skillName(skillPath: string): string {
  const parts = skillPath.split('/').filter(Boolean);
  const file = parts.at(-1) ?? skillPath;
  if (file.toLowerCase() === 'skill.md' && parts.length > 1) return parts.at(-2)!;
  return file;
}

/**
 * The collapsed line and the text the expand control reveals.
 *
 * `nodeSummary` cuts config text to a canvas-sized line, so a control that only
 * unwraps that string has nothing left to show. Details come from the rest of the config.
 */
export function playbookStepOutline(
  node: Pick<PlaybookGraphNode, 'id' | 'stepType' | 'config'>,
  summaryOverride?: string,
): PlaybookStepOutline {
  const meta = stepMeta(node.stepType);
  const subject = configString(node.config, 'subject');
  const title = configString(node.config, 'title');
  const prompt = configString(node.config, 'prompt');
  const body = configString(node.config, 'body');
  const skillPath = configString(node.config, 'skillPath');
  const summary = summaryOverride ?? subject ?? title ?? meta.description;
  const details: string[] = [];
  const add = (line: string | null | undefined) => {
    const text = line?.trim();
    if (!text || text === summary || details.includes(text)) return;
    details.push(text);
  };

  if (node.stepType === 'cursor-agent') {
    if (skillPath) add(`Skill: ${skillName(skillPath)}`);
    add(prompt);
  } else if (node.stepType === 'board-deliberation') {
    const topics = node.config?.maxTopics;
    const rounds = node.config?.maxRounds;
    const budget = node.config?.inquiryBudget;
    if (
      typeof topics === 'number' &&
      typeof rounds === 'number' &&
      typeof budget === 'number'
    ) {
      add(`Up to ${topics} topics, ${rounds} rounds, and ${budget} inquiries.`);
    }
    add('Named specialists respond to the disagreements the moderator selects.');
  } else if (node.stepType === 'capture-outcome-feedback' || node.stepType === 'feedback-review') {
    const sources = node.config?.sourceStepIds;
    if (Array.isArray(sources) && sources.length > 0) {
      add(
        node.stepType === 'feedback-review'
          ? `Reviews ${sources.length} selected AI step${sources.length === 1 ? '' : 's'}.`
          : `Learns from ${sources.length} earlier AI step${sources.length === 1 ? '' : 's'}.`
      );
    }
    add(configString(node.config, 'label'));
  } else if (node.stepType === 'approval-gate') {
    add(meta.description);
  } else if (node.stepType === 'notify') {
    add(body);
  }

  return { summary, details };
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
