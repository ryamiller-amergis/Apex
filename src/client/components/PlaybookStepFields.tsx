/**
 * Hand-built settings for the step types an author meets most. Each renderer names the config keys
 * it owns; the inspector renders any other schema key with the generic form.
 */
import React, { useState } from 'react';
import {
  BookOpenText,
  Cpu,
  FileCheck2,
  ListPlus,
  MessageSquarePlus,
  ShieldCheck,
  SquarePen,
  Ticket,
  UserCheck,
  Users,
} from 'lucide-react';
import type { PlaybookGraphNode, PlaybookStepTypePaletteItem } from '../../shared/types/playbook';
import { useAvailableModels, usePlaybookSkills } from '../hooks/usePlaybookCanvas';
import {
  nearestProducer,
  type PlaybookBindingOption,
  type PlaybookTokenReference,
} from '../utils/playbookBindings';
import { PlaybookBindingText } from './PlaybookBindingText';
import { PlaybookOptionPicker, type PlaybookPickerOption } from './PlaybookOptionPicker';
import { stepDisplayName } from './playbookStepCatalog';
import styles from './PlaybookBuilder.module.css';

type Config = Record<string, unknown>;

export interface PlaybookStepFieldsProps {
  project: string;
  node: PlaybookGraphNode;
  config: Config;
  disabled: boolean;
  /** Earlier steps, nearest first. */
  priorNodeIds: readonly string[];
  nextNodeIds: readonly string[];
  allNodes: readonly PlaybookGraphNode[];
  paletteItems: readonly PlaybookStepTypePaletteItem[];
  bindings: readonly PlaybookBindingOption[];
  referencesFor: (text: string) => PlaybookTokenReference[];
  setField: (key: string, value: unknown) => void;
  setConfig: (config: Config) => void;
}

const Field: React.FC<{
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: React.ReactNode;
  children: React.ReactNode;
  'data-testid'?: string;
}> = ({ label, htmlFor, required, hint, children, 'data-testid': testId }) => (
  <div className={styles.field} {...(testId ? { 'data-testid': testId } : {})}>
    <label htmlFor={htmlFor} className={styles.fieldLabel}>
      {label}
      {required ? <span className={styles.fieldRequired} aria-label="required">*</span> : null}
    </label>
    {children}
    {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
  </div>
);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** A deadline in minutes or hours, stored as milliseconds. */
export const DeadlineField: React.FC<{
  id: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: number | undefined) => void;
  'data-testid': string;
}> = ({ id, value, disabled, onChange, 'data-testid': testId }) => {
  const initialUnit = typeof value === 'number' && value % HOUR_MS === 0 ? HOUR_MS : MINUTE_MS;
  const [unit, setUnit] = useState(initialUnit);
  const [text, setText] = useState(typeof value === 'number' ? String(value / initialUnit) : '');
  const commit = (nextText: string, nextUnit: number) => {
    const parsed = Number(nextText);
    onChange(nextText.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed * nextUnit : undefined);
  };
  return (
    <div className={styles.inlineFields}>
      <input
        id={id}
        className={styles.fieldInput}
        inputMode="numeric"
        placeholder="Default"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          commit(event.target.value, unit);
        }}
        {...{ 'data-testid': testId }}
      />
      <select
        className={`${styles.fieldInput} ${styles.unitSelect}`}
        value={unit}
        disabled={disabled}
        aria-label="Deadline unit"
        onChange={(event) => {
          const nextUnit = Number(event.target.value);
          setUnit(nextUnit);
          commit(text, nextUnit);
        }}
        {...{ 'data-testid': `${testId}-unit` }}
      >
        <option value={MINUTE_MS}>minutes</option>
        <option value={HOUR_MS}>hours</option>
      </select>
    </div>
  );
};

function skillTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CursorAgentFields: React.FC<PlaybookStepFieldsProps> = (props) => {
  const { project, node, config, disabled, setField, bindings, referencesFor } = props;
  const skills = usePlaybookSkills(project);
  const models = useAvailableModels();
  const skillPath = typeof config.skillPath === 'string' ? config.skillPath.replace(/^[/\\]+/, '') : undefined;
  const skillOptions: PlaybookPickerOption[] = (skills.data?.skills ?? []).map((skill) => ({
    value: skill.path,
    label: skillTitle(skill.name),
    description: skill.description,
    badges: skill.capabilities ?? [],
    disabled: !skill.runnable,
    disabledReason: 'Not enabled for Playbooks: its frontmatter does not declare playbook-capabilities.',
  }));
  const modelOptions: PlaybookPickerOption[] = (models.data?.models ?? []).map((model) => ({
    value: model.id,
    label: model.displayName,
    description: model.id,
  }));
  const prompt = typeof config.prompt === 'string' ? config.prompt : '';
  return (
    <>
      <Field label="Skill" htmlFor={`${node.id}-skill`} required hint="The procedure the agent follows." {...{ 'data-testid': `playbook-field-${node.id}-skill` }}>
        <PlaybookOptionPicker
          id={`${node.id}-skill`}
          value={skillPath}
          options={skillOptions}
          loading={skills.isPending}
          placeholder="Choose a Skill"
          searchPlaceholder="Search Skills"
          icon={<BookOpenText size={14} />}
          disabled={disabled}
          onChange={(value) => setField('skillPath', value)}
          {...{ 'data-testid': "playbook-inspector-field-skillPath" }}
        />
      </Field>
      <Field label="Prompt" htmlFor={`${node.id}-prompt`} required hint="What this run of the Skill should do." {...{ 'data-testid': `playbook-field-${node.id}-prompt` }}>
        <PlaybookBindingText
          id={`${node.id}-prompt`}
          value={prompt}
          multiline
          placeholder="For example: Investigate the last 24 hours of production errors."
          disabled={disabled}
          bindings={bindings}
          references={referencesFor(prompt)}
          onChange={(value) => setField('prompt', value)}
          {...{ 'data-testid': "playbook-inspector-field-prompt" }}
        />
      </Field>
      <Field label="Model" htmlFor={`${node.id}-model`} {...{ 'data-testid': `playbook-field-${node.id}-model` }}>
        <PlaybookOptionPicker
          id={`${node.id}-model`}
          value={typeof config.model === 'string' ? config.model : undefined}
          options={modelOptions}
          loading={models.isPending}
          placeholder="Choose a model"
          searchPlaceholder="Search models"
          emptyOption={{ label: 'Project default', description: 'Uses the model set for this project' }}
          icon={<Cpu size={14} />}
          disabled={disabled}
          onChange={(value) => setField('model', value)}
          {...{ 'data-testid': "playbook-inspector-field-model" }}
        />
      </Field>
      <Field
        label="Access"
        htmlFor={`${node.id}-mcp`}
        required
        hint="Read-only access lets the agent run before an approval."
        {...{ 'data-testid': `playbook-field-${node.id}-mcp` }}
      >
        <PlaybookOptionPicker
          id={`${node.id}-mcp`}
          value={typeof config.mcpProfile === 'string' ? config.mcpProfile : undefined}
          options={[{
            value: 'repository-read-only',
            label: 'Read-only repository',
            description: 'Reads code and the network. No external writes or deployment.',
          }]}
          placeholder="Choose access"
          icon={<ShieldCheck size={14} />}
          disabled={disabled}
          onChange={(value) => setField('mcpProfile', value)}
          {...{ 'data-testid': "playbook-inspector-field-mcpProfile" }}
        />
      </Field>
      <Field label="Deadline" htmlFor={`${node.id}-deadline`} hint="Blank uses the step's default." {...{ 'data-testid': `playbook-field-${node.id}-deadline` }}>
        <DeadlineField
          id={`${node.id}-deadline`}
          value={config.deadlineMs}
          disabled={disabled}
          onChange={(value) => setField('deadlineMs', value)}
          {...{ 'data-testid': "playbook-inspector-field-deadlineMs" }}
        />
      </Field>
    </>
  );
};

const APPROVER_POOLS: PlaybookPickerOption[] = [
  { value: 'prd', label: 'PRD reviewers', description: 'The project\u2019s PRD approver group' },
  { value: 'design_doc', label: 'Design doc reviewers', description: 'The project\u2019s design doc approver group' },
  { value: 'design_prototype', label: 'Prototype reviewers', description: 'The project\u2019s prototype approver group' },
  { value: 'test_case', label: 'Test case reviewers', description: 'The project\u2019s test case approver group' },
  { value: 'adr', label: 'ADR reviewers', description: 'The project\u2019s ADR approver group' },
];

const ApprovalGateFields: React.FC<PlaybookStepFieldsProps> = (props) => {
  const { node, config, disabled, setConfig, setField, bindings, referencesFor, nextNodeIds, priorNodeIds, allNodes } = props;
  const routed = Boolean(config.approverPool || config.gatedStepId);
  const [mode, setMode] = useState<'initiator' | 'group'>(routed ? 'group' : 'initiator');
  const subject = typeof config.subject === 'string' ? config.subject : '';
  const label = (id: string) => {
    const found = allNodes.find((candidate) => candidate.id === id);
    return found ? stepDisplayName(found) : id;
  };
  const reviewOptions: PlaybookPickerOption[] = [
    ...nextNodeIds.map((id) => ({ value: id, label: label(id), description: 'Next step: reviewers see what it will do' })),
    ...priorNodeIds.map((id) => ({ value: id, label: label(id), description: 'Earlier step: reviewers see what it did' })),
  ];
  const chooseMode = (next: 'initiator' | 'group') => {
    setMode(next);
    const { approverPool: _pool, gatedStepId: _gated, ...rest } = config;
    if (next === 'initiator') {
      setConfig(rest);
    } else {
      setConfig({ ...rest, approverPool: 'prd', ...(nextNodeIds[0] ? { gatedStepId: nextNodeIds[0] } : {}) });
    }
  };
  return (
    <>
      <div className={styles.infoCard}>
        <ShieldCheck size={15} aria-hidden />
        <span>
          Every step after this one waits for the decision. You don&apos;t need to pick the steps it protects.
        </span>
      </div>
      <Field label="What to approve" htmlFor={`${node.id}-subject`} hint="The title approvers read." {...{ 'data-testid': `playbook-field-${node.id}-subject` }}>
        <PlaybookBindingText
          id={`${node.id}-subject`}
          value={subject}
          placeholder="For example: Approve the fix before it is filed"
          disabled={disabled}
          bindings={bindings}
          references={referencesFor(subject)}
          onChange={(value) => setField('subject', value)}
          {...{ 'data-testid': "playbook-inspector-field-subject" }}
        />
      </Field>
      <div className={styles.field} role="radiogroup" aria-label="Who approves">
        <span className={styles.fieldLabel}>Who approves</span>
        <div className={styles.choiceCards}>
          {([
            ['initiator', UserCheck, 'Whoever started the run', 'The run owner, or the trigger owner for automatic runs.'],
            ['group', Users, 'A reviewer group', 'Anyone in one of the project\u2019s approver groups.'],
          ] as const).map(([value, Icon, title, description]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              disabled={disabled}
              className={`${styles.choiceCard} ${mode === value ? styles.choiceCardActive : ''}`}
              onClick={() => chooseMode(value)}
              {...{ 'data-testid': `playbook-gate-approver-${value}` }}
            >
              <Icon size={15} aria-hidden />
              <span className={styles.choiceText}>
                <span className={styles.choiceTitle}>{title}</span>
                <span className={styles.choiceDescription}>{description}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {mode === 'group' ? (
        <>
          <Field label="Reviewer group" htmlFor={`${node.id}-pool`} required {...{ 'data-testid': `playbook-field-${node.id}-pool` }}>
            <PlaybookOptionPicker
              id={`${node.id}-pool`}
              value={typeof config.approverPool === 'string' ? config.approverPool : undefined}
              options={APPROVER_POOLS}
              placeholder="Choose a group"
              icon={<Users size={14} />}
              disabled={disabled}
              onChange={(value) => setField('approverPool', value)}
              {...{ 'data-testid': "playbook-inspector-field-approverPool" }}
            />
          </Field>
          <Field
            label="Show reviewers"
            htmlFor={`${node.id}-gated`}
            required
            hint="The step whose settings appear on the review screen."
            {...{ 'data-testid': `playbook-field-${node.id}-gated` }}
          >
            <PlaybookOptionPicker
              id={`${node.id}-gated`}
              value={typeof config.gatedStepId === 'string' ? config.gatedStepId : undefined}
              options={reviewOptions}
              placeholder={reviewOptions.length ? 'Choose a step' : 'Connect this approval to a step first'}
              icon={<FileCheck2 size={14} />}
              disabled={disabled || reviewOptions.length === 0}
              onChange={(value) => setField('gatedStepId', value)}
              {...{ 'data-testid': "playbook-inspector-field-gatedStepId" }}
            />
          </Field>
        </>
      ) : null}
      <Field label="Deadline" htmlFor={`${node.id}-deadline`} hint="Blank waits up to 48 hours." {...{ 'data-testid': `playbook-field-${node.id}-deadline` }}>
        <DeadlineField
          id={`${node.id}-deadline`}
          value={config.deadlineMs}
          disabled={disabled}
          onChange={(value) => setField('deadlineMs', value)}
          {...{ 'data-testid': "playbook-inspector-field-deadlineMs" }}
        />
      </Field>
    </>
  );
};

const WORK_ITEM_TYPES = ['Bug', 'Production Bug', 'Product Backlog Item', 'Technical Backlog Item', 'Task', 'Feature', 'Epic'];

/** Where a step gets its work item: automatic, an earlier step, the trigger, or a fixed id. */
const WorkItemSourceField: React.FC<PlaybookStepFieldsProps & {
  value: unknown;
  /** Persisted choice. `manual` with no id must not be read as automatic. */
  source?: unknown;
  allowAutomatic: boolean;
  onValue: (value: unknown) => void;
  onSource?: (source: 'manual' | undefined) => void;
  /** Writes the id and the manual/automatic choice in one update. */
  onCommit?: (next: { value: unknown; source: 'manual' | undefined }) => void;
  'data-testid'?: string;
}> = (props) => {
  const {
    node, value, source, allowAutomatic, onValue, onSource, onCommit, disabled, priorNodeIds, allNodes, paletteItems,
  } = props;
  const commit = (nextValue: unknown, nextSource: 'manual' | undefined) => {
    if (onCommit) onCommit({ value: nextValue, source: nextSource });
    else {
      onSource?.(nextSource);
      onValue(nextValue);
    }
  };
  const producers = priorNodeIds
    .map((id) => allNodes.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is PlaybookGraphNode => Boolean(
      candidate
      && nearestProducer('workItemId', [candidate.id], allNodes, paletteItems),
    ));
  const automaticSource = producers[0];
  const options: PlaybookPickerOption[] = [
    ...(allowAutomatic ? [{
      value: 'auto',
      label: 'Automatic',
      description: automaticSource
        ? `Uses the work item ${stepDisplayName(automaticSource)} creates`
        : 'Uses the work item from the trigger that started the run',
      badges: ['Recommended'],
    }] : []),
    ...producers.map((producer) => ({
      value: `\${steps.${producer.id}.workItemId}`,
      label: `From ${stepDisplayName(producer)}`,
      description: 'The work item that step creates',
    })),
    {
      value: '${input.workItemId}',
      label: 'From the trigger',
      description: 'The work item whose Azure DevOps event started the run',
    },
    { value: 'manual', label: 'A specific work item', description: 'Always the same work item id' },
  ];
  const inferredMode = source === 'manual' || typeof value === 'number'
    ? 'manual'
    : value === undefined
      ? (allowAutomatic ? 'auto' : undefined)
      : String(value);
  const [mode, setMode] = useState<string | undefined>(inferredMode);
  const [modeNodeId, setModeNodeId] = useState(node.id);
  if (modeNodeId !== node.id) {
    setModeNodeId(node.id);
    setMode(inferredMode);
  }
  const [manualText, setManualText] = useState(typeof value === 'number' ? String(value) : '');
  return (
    <>
      <PlaybookOptionPicker
        id={`${node.id}-work-item`}
        value={mode}
        options={options}
        placeholder="Choose where the work item comes from"
        icon={<Ticket size={14} />}
        disabled={disabled}
        onChange={(next) => {
          setMode(next);
          if (next === 'auto' || next === undefined) commit(undefined, undefined);
          else if (next === 'manual') {
            const parsed = Number(manualText);
            commit(Number.isInteger(parsed) && parsed > 0 ? parsed : undefined, 'manual');
          } else commit(next, undefined);
        }}
        {...{ 'data-testid': "playbook-inspector-field-workItemId" }}
      />
      {mode === 'manual' ? (
        <input
          className={styles.fieldInput}
          inputMode="numeric"
          placeholder="Work item id, for example 12345"
          aria-label="Work item id"
          value={manualText}
          disabled={disabled}
          onChange={(event) => {
            setManualText(event.target.value);
            const parsed = Number(event.target.value);
            commit(Number.isInteger(parsed) && parsed > 0 ? parsed : undefined, 'manual');
          }}
          {...{ 'data-testid': "playbook-inspector-field-workItemId-manual" }}
        />
      ) : null}
    </>
  );
};

const CloudAgentFields: React.FC<PlaybookStepFieldsProps> = (props) => {
  const { node, config, disabled, setField, setConfig, bindings, referencesFor } = props;
  const prompt = typeof config.prompt === 'string' ? config.prompt : '';
  const overridden = Boolean(config.workItemType || config.state || config.tags);
  return (
    <>
      <Field
        label="Work item"
        htmlFor={`${node.id}-work-item`}
        hint="The Cloud Agent reads the work item's type, state, and tags from Azure DevOps."
        {...{ 'data-testid': `playbook-field-${node.id}-work-item` }}
      >
        <WorkItemSourceField
          {...props}
          value={config.workItemId}
          source={config.workItemSource}
          allowAutomatic
          onValue={(value) => setField('workItemId', value)}
          onCommit={({ value, source }) => {
            const next = { ...config };
            if (value === undefined) delete next.workItemId;
            else next.workItemId = value;
            if (source === undefined) delete next.workItemSource;
            else next.workItemSource = source;
            setConfig(next);
          }}
          {...{ 'data-testid': `playbook-work-item-source-${node.id}` }}
        />
      </Field>
      <Field label="Extra instructions" htmlFor={`${node.id}-prompt`} hint="Optional. Added to the work item's own description." {...{ 'data-testid': `playbook-field-${node.id}-prompt` }}>
        <PlaybookBindingText
          id={`${node.id}-prompt`}
          value={prompt}
          multiline
          placeholder="For example: Keep the fix small and add a regression test."
          disabled={disabled}
          bindings={bindings}
          references={referencesFor(prompt)}
          onChange={(value) => setField('prompt', value)}
          {...{ 'data-testid': "playbook-inspector-field-prompt" }}
        />
      </Field>
      <details className={styles.moreSettings} open={overridden}>
        <summary {...{ 'data-testid': "playbook-cloud-agent-overrides" }}>Override work item details</summary>
        <p className={styles.fieldHint}>Leave these blank. Fill one in only to start the Cloud Agent as if the item had that value.</p>
        {(['workItemType', 'state', 'tags'] as const).map((key) => (
          <Field key={key} label={{ workItemType: 'Type', state: 'State', tags: 'Tags' }[key]} htmlFor={`${node.id}-${key}`} {...{ 'data-testid': `playbook-field-${node.id}-${key}` }}>
            <input
              id={`${node.id}-${key}`}
              className={styles.fieldInput}
              list={key === 'workItemType' ? `${node.id}-types` : undefined}
              value={typeof config[key] === 'string' ? (config[key] as string) : ''}
              placeholder="From Azure DevOps"
              disabled={disabled}
              onChange={(event) => setField(key, event.target.value || undefined)}
              {...{ 'data-testid': `playbook-inspector-field-${key}` }}
            />
          </Field>
        ))}
        <datalist id={`${node.id}-types`}>
          {WORK_ITEM_TYPES.map((type) => <option key={type} value={type} />)}
        </datalist>
      </details>
      <Field label="Deadline" htmlFor={`${node.id}-deadline`} hint="Blank waits up to 6 hours." {...{ 'data-testid': `playbook-field-${node.id}-deadline` }}>
        <DeadlineField
          id={`${node.id}-deadline`}
          value={config.deadlineMs}
          disabled={disabled}
          onChange={(value) => setField('deadlineMs', value)}
          {...{ 'data-testid': "playbook-inspector-field-deadlineMs" }}
        />
      </Field>
    </>
  );
};

const APEX_OPERATIONS: Array<PlaybookPickerOption & { icon: React.ReactNode }> = [
  {
    value: 'create-work-item',
    label: 'Create a work item',
    description: 'Files a Bug or backlog item in Azure DevOps and passes its id on.',
    icon: <SquarePen size={14} />,
  },
  {
    value: 'post-ado-comment',
    label: 'Comment on a work item',
    description: 'Posts a comment on an Azure DevOps work item.',
    icon: <MessageSquarePlus size={14} />,
  },
  {
    value: 'set-document-status',
    label: 'Approve a document',
    description: 'Marks a PRD or design doc approved.',
    icon: <FileCheck2 size={14} />,
  },
  {
    value: 'create-ado-items',
    label: 'Create backlog items',
    description: 'Creates an epic with features and backlog items.',
    icon: <ListPlus size={14} />,
  },
];

function defaultParameters(operation: string, props: PlaybookStepFieldsProps): Config {
  const agent = props.priorNodeIds
    .map((id) => props.allNodes.find((candidate) => candidate.id === id))
    .find((candidate) => candidate?.stepType === 'cursor-agent');
  const creator = nearestProducer('workItemId', props.priorNodeIds, props.allNodes, props.paletteItems);
  if (operation === 'create-work-item') {
    return {
      workItemType: 'Bug',
      title: 'Playbook finding',
      description: agent ? `\${steps.${agent.id}.reportMd}` : '',
    };
  }
  if (operation === 'post-ado-comment') {
    return {
      workItemId: creator ? `\${steps.${creator.id}.workItemId}` : '${input.workItemId}',
      text: agent ? `\${steps.${agent.id}.reportMd}` : '',
    };
  }
  if (operation === 'set-document-status') return { documentType: 'design_doc', documentId: '', status: 'approved' };
  return { epic: { id: 'epic-1', title: '' }, features: [], pbis: [] };
}

const ApexActionFields: React.FC<PlaybookStepFieldsProps> = (props) => {
  const { node, config, disabled, setConfig, bindings, referencesFor } = props;
  const operation = typeof config.operation === 'string' ? config.operation : undefined;
  const parameters = (config.parameters && typeof config.parameters === 'object' && !Array.isArray(config.parameters)
    ? config.parameters
    : {}) as Config;
  const setParameter = (key: string, value: unknown) => {
    const next = { ...parameters };
    if (value === undefined) delete next[key];
    else next[key] = value;
    setConfig({ ...config, parameters: next });
  };
  const text = (key: string) => (typeof parameters[key] === 'string' ? (parameters[key] as string) : '');
  const bindingField = (key: string, label: string, options: { multiline?: boolean; placeholder?: string; hint?: string } = {}) => (
    <Field label={label} htmlFor={`${node.id}-${key}`} required hint={options.hint} {...{ 'data-testid': `playbook-field-${node.id}-${key}` }}>
      <PlaybookBindingText
        id={`${node.id}-${key}`}
        value={text(key)}
        multiline={options.multiline}
        placeholder={options.placeholder}
        disabled={disabled}
        bindings={bindings}
        references={referencesFor(text(key))}
        onChange={(value) => setParameter(key, value ?? '')}
        {...{ 'data-testid': `playbook-inspector-param-${key}` }}
      />
    </Field>
  );
  const selected = APEX_OPERATIONS.find((option) => option.value === operation);
  return (
    <>
      <Field label="Action" htmlFor={`${node.id}-operation`} required {...{ 'data-testid': `playbook-field-${node.id}-operation` }}>
        <PlaybookOptionPicker
          id={`${node.id}-operation`}
          value={operation}
          options={APEX_OPERATIONS}
          placeholder="Choose what this step does"
          icon={selected?.icon}
          disabled={disabled}
          onChange={(value) => {
            if (!value) return;
            setConfig({ ...config, operation: value, parameters: defaultParameters(value, props) });
          }}
          {...{ 'data-testid': "playbook-inspector-field-operation" }}
        />
      </Field>
      {operation === 'create-work-item' ? (
        <>
          <Field label="Work item type" htmlFor={`${node.id}-workItemType`} required {...{ 'data-testid': `playbook-field-${node.id}-workItemType` }}>
            <input
              id={`${node.id}-workItemType`}
              className={styles.fieldInput}
              list={`${node.id}-types`}
              value={text('workItemType')}
              disabled={disabled}
              onChange={(event) => setParameter('workItemType', event.target.value)}
              {...{ 'data-testid': "playbook-inspector-param-workItemType" }}
            />
            <datalist id={`${node.id}-types`}>
              {WORK_ITEM_TYPES.map((type) => <option key={type} value={type} />)}
            </datalist>
          </Field>
          {bindingField('title', 'Title', { placeholder: 'For example: Nightly scan finding' })}
          {bindingField('description', 'Description', {
            multiline: true,
            hint: 'Use Insert data to put an earlier step\u2019s report here.',
          })}
        </>
      ) : null}
      {operation === 'post-ado-comment' ? (
        <>
          <Field label="Work item" htmlFor={`${node.id}-work-item`} required {...{ 'data-testid': `playbook-field-${node.id}-work-item` }}>
            <WorkItemSourceField
              {...props}
              value={parameters.workItemId}
              allowAutomatic={false}
              onValue={(value) => setParameter('workItemId', value)}
              {...{ 'data-testid': `playbook-work-item-source-${node.id}` }}
            />
          </Field>
          {bindingField('text', 'Comment', { multiline: true })}
        </>
      ) : null}
      {operation === 'set-document-status' ? (
        <>
          <Field label="Document type" htmlFor={`${node.id}-documentType`} required {...{ 'data-testid': `playbook-field-${node.id}-documentType` }}>
            <select
              id={`${node.id}-documentType`}
              className={styles.fieldInput}
              value={text('documentType') || 'design_doc'}
              disabled={disabled}
              onChange={(event) => setParameter('documentType', event.target.value)}
              {...{ 'data-testid': "playbook-inspector-param-documentType" }}
            >
              <option value="design_doc">Design doc</option>
              <option value="prd">PRD</option>
            </select>
          </Field>
          {bindingField('documentId', 'Document id', { placeholder: 'Insert it from the trigger or an earlier step' })}
          <p className={styles.fieldHint}>The document is set to approved.</p>
        </>
      ) : null}
      {operation === 'create-ado-items' ? (
        <p className={styles.fieldHint}>
          Backlog items are a nested list. Edit them on the JSON tab.
        </p>
      ) : null}
    </>
  );
};

export const STEP_FIELD_RENDERERS: Record<string, {
  handledKeys: readonly string[];
  Component: React.FC<PlaybookStepFieldsProps>;
}> = {
  'cursor-agent': {
    handledKeys: ['skillPath', 'prompt', 'model', 'mcpProfile', 'deadlineMs', 'threadId'],
    Component: CursorAgentFields,
  },
  'approval-gate': {
    handledKeys: ['subject', 'approverPool', 'gatedStepId', 'deadlineMs'],
    Component: ApprovalGateFields,
  },
  'apex-action': {
    handledKeys: ['operation', 'parameters'],
    Component: ApexActionFields,
  },
  'cloud-agent': {
    handledKeys: ['workItemId', 'workItemSource', 'workItemType', 'state', 'tags', 'prompt', 'deadlineMs'],
    Component: CloudAgentFields,
  },
};
