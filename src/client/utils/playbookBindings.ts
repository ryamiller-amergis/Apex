/**
 * The values a step can read: any output field of a step that finishes before it, plus the run
 * input. An approval in between only pauses the run; it does not hide earlier outputs.
 */
import type { PlaybookGraphNode, PlaybookStepTypePaletteItem } from '../../shared/types/playbook';
import { stepMeta } from '../components/playbookStepCatalog';

export interface PlaybookBindingOption {
  token: string;
  /** Empty for run input. */
  stepId: string;
  sourceLabel: string;
  field: string;
  fieldLabel: string;
}

const OUTPUT_FIELD_LABELS: Record<string, string> = {
  reportMd: 'Report',
  scorecard: 'Scorecard',
  agentRunId: 'Agent run id',
  threadId: 'Thread id',
  completedAt: 'Finished at',
  decision: 'Decision',
  decidedBy: 'Decided by',
  workItemId: 'Work item id',
  workItemType: 'Work item type',
  summary: 'Summary',
  operation: 'Operation',
  runId: 'Run id',
  status: 'Status',
  pullRequestUrl: 'Pull request link',
  notificationId: 'Notification id',
  recipientUserId: 'Recipient',
  item: 'Current item',
  index: 'Item number',
  title: 'Title',
  state: 'State',
  outcome: 'Outcome',
  verdict: 'Verdict',
  isReady: 'Is ready',
  matched: 'Condition matched',
};

/** Fields a trigger can put on the run input. An Azure DevOps trigger sets all four. */
export const RUN_INPUT_FIELDS: readonly string[] = ['workItemId', 'workItemType', 'title', 'state'];

const STEP_TOKEN = /\$\{steps\.([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_]*)\}/g;
const INPUT_TOKEN = /\$\{input\.([A-Za-z][A-Za-z0-9_-]*)\}/g;
export const ANY_TOKEN = /\$\{(?:steps\.[A-Za-z][A-Za-z0-9_-]*\.[A-Za-z][A-Za-z0-9_]*|input\.[A-Za-z][A-Za-z0-9_-]*)\}/g;

export function fieldLabel(field: string): string {
  if (OUTPUT_FIELD_LABELS[field]) return OUTPUT_FIELD_LABELS[field];
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function outputFields(item: PlaybookStepTypePaletteItem | undefined): string[] {
  const properties = (item?.outputJsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Object.keys(properties ?? {});
}

function stepLabel(node: PlaybookGraphNode): string {
  return `${stepMeta(node.stepType).title} (${node.id})`;
}

export function availableBindings(
  priorNodeIds: readonly string[],
  allNodes: readonly PlaybookGraphNode[],
  paletteItems: readonly PlaybookStepTypePaletteItem[],
): PlaybookBindingOption[] {
  const options: PlaybookBindingOption[] = [];
  for (const node of allNodes) {
    if (!priorNodeIds.includes(node.id)) continue;
    const item = paletteItems.find((candidate) => candidate.stepType === node.stepType);
    for (const field of outputFields(item)) {
      options.push({
        token: `\${steps.${node.id}.${field}}`,
        stepId: node.id,
        sourceLabel: stepLabel(node),
        field,
        fieldLabel: fieldLabel(field),
      });
    }
  }
  for (const field of RUN_INPUT_FIELDS) {
    options.push({
      token: `\${input.${field}}`,
      stepId: '',
      sourceLabel: 'Trigger input',
      field,
      fieldLabel: fieldLabel(field),
    });
  }
  return options;
}

export interface PlaybookTokenReference {
  token: string;
  label: string;
  valid: boolean;
}

/** Every distinct placeholder in a config, with a readable name and whether it can resolve. */
export function tokenReferences(
  text: string,
  priorNodeIds: readonly string[],
  allNodes: readonly PlaybookGraphNode[],
  paletteItems: readonly PlaybookStepTypePaletteItem[],
): PlaybookTokenReference[] {
  const seen = new Map<string, PlaybookTokenReference>();
  for (const match of text.matchAll(STEP_TOKEN)) {
    const node = allNodes.find((candidate) => candidate.id === match[1]);
    const item = paletteItems.find((candidate) => candidate.stepType === node?.stepType);
    seen.set(match[0], {
      token: match[0],
      label: `${node ? stepLabel(node) : match[1]} › ${fieldLabel(match[2])}`,
      valid: Boolean(node && priorNodeIds.includes(node.id) && outputFields(item).includes(match[2])),
    });
  }
  for (const match of text.matchAll(INPUT_TOKEN)) {
    seen.set(match[0], { token: match[0], label: `Trigger input › ${fieldLabel(match[1])}`, valid: true });
  }
  return [...seen.values()];
}

/** The nearest earlier step whose output has the field, for "automatic" wiring. */
export function nearestProducer(
  field: string,
  priorNodeIdsNearestFirst: readonly string[],
  allNodes: readonly PlaybookGraphNode[],
  paletteItems: readonly PlaybookStepTypePaletteItem[],
): PlaybookGraphNode | undefined {
  for (const id of priorNodeIdsNearestFirst) {
    const node = allNodes.find((candidate) => candidate.id === id);
    const item = paletteItems.find((candidate) => candidate.stepType === node?.stepType);
    if (!node || !outputFields(item).includes(field)) continue;
    if (
      node.stepType === 'apex-action'
      && field === 'workItemId'
      && node.config?.operation !== 'create-work-item'
    ) continue;
    return node;
  }
  return undefined;
}
