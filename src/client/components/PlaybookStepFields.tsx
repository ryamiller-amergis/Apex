/**
 * Hand-built settings for the step types an author meets most. Each renderer names the config keys
 * it owns; the inspector renders any other schema key with the generic form.
 */
import React, { useState } from 'react';
import {
  Bell,
  BellOff,
  BookOpenText,
  Cpu,
  FileCheck2,
  GitBranch,
  ListPlus,
  MessageSquarePlus,
  Plus,
  ShieldCheck,
  SquarePen,
  Ticket,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import {
  PLAYBOOK_MAX_OUTCOMES,
  PLAYBOOK_OUTCOME_PATTERN,
  type PlaybookBranchCondition,
  type PlaybookGraphNode,
  type PlaybookStepTypePaletteItem,
} from '../../shared/types/playbook';
import {
  PLAYBOOK_CONNECTORS,
  playbookConnector,
  playbookConnectorOperation,
} from '../../shared/types/playbookConnectors';
import { usePlaybookSkills } from '../hooks/usePlaybookCanvas';
import { useAvailableModels } from '../hooks/useProjectSkillConfig';
import {
  comparableOutputFields,
  nearestProducer,
  type PlaybookBindingOption,
  type PlaybookComparableField,
  type PlaybookComparableKind,
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

/** The results an agent picks from, stored lowercase so its answer compares exactly. */
const OutcomesField: React.FC<{
  id: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: string[] | undefined) => void;
}> = ({ id, value, disabled, onChange }) => {
  const outcomes = Array.isArray(value) ? value.map(String) : [];
  const [draft, setDraft] = useState('');
  const candidate = draft.trim().toLowerCase().replace(/\s+/g, ' ');
  const problem = !candidate
    ? null
    : outcomes.includes(candidate)
      ? 'Already in the list.'
      : !PLAYBOOK_OUTCOME_PATTERN.test(candidate)
        ? 'Use letters, numbers, spaces, or hyphens, up to 40 characters.'
        : outcomes.length >= PLAYBOOK_MAX_OUTCOMES
          ? `Up to ${PLAYBOOK_MAX_OUTCOMES} outcomes.`
          : null;
  const add = () => {
    if (!candidate || problem) return;
    onChange([...outcomes, candidate]);
    setDraft('');
  };
  return (
    <>
      {outcomes.length ? (
        <ul className={styles.outcomeList} aria-label="Outcomes">
          {outcomes.map((outcome) => (
            <li key={outcome} className={styles.outcomeChip}>
              {outcome}
              <button
                type="button"
                className={styles.outcomeRemove}
                aria-label={`Remove ${outcome}`}
                disabled={disabled}
                onClick={() => {
                  const next = outcomes.filter((existing) => existing !== outcome);
                  onChange(next.length ? next : undefined);
                }}
                {...{ 'data-testid': `playbook-outcome-remove-${outcome}` }}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.outcomeAdd}>
        <input
          id={id}
          className={styles.fieldInput}
          placeholder={outcomes.length ? 'Add another outcome' : 'For example: fixed'}
          value={draft}
          disabled={disabled}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          {...{ 'data-testid': 'playbook-inspector-field-outcomes' }}
        />
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={disabled || !candidate || Boolean(problem)}
          onClick={add}
          {...{ 'data-testid': 'playbook-outcome-add' }}
        >
          <Plus size={14} aria-hidden /> Add
        </button>
      </div>
      {problem ? <span className={styles.fieldError}>{problem}</span> : null}
      {outcomes.length === 1 ? <span className={styles.fieldError}>Add at least one more outcome.</span> : null}
    </>
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
    ...(skill.unavailableReason ? { disabledReason: skill.unavailableReason } : {}),
  }));
  const modelOptions: PlaybookPickerOption[] = (models.data ?? []).map((model) => ({
    value: model.id,
    label: model.displayName,
    description: model.id,
  }));
  const prompt = typeof config.prompt === 'string' ? config.prompt : '';
  return (
    <>
      <Field label="Skill" htmlFor={`${node.id}-skill`} hint="Optional. A procedure the agent follows on top of your prompt." {...{ 'data-testid': `playbook-field-${node.id}-skill` }}>
        <PlaybookOptionPicker
          id={`${node.id}-skill`}
          value={skillPath}
          options={skillOptions}
          loading={skills.isPending}
          placeholder="No Skill"
          searchPlaceholder="Search Skills"
          emptyOption={{ label: 'No Skill', description: 'The agent follows your prompt only' }}
          icon={<BookOpenText size={14} />}
          disabled={disabled}
          onChange={(value) => setField('skillPath', value)}
          {...{ 'data-testid': "playbook-inspector-field-skillPath" }}
        />
      </Field>
      <Field label="Prompt" htmlFor={`${node.id}-prompt`} required hint="What the agent should do." {...{ 'data-testid': `playbook-field-${node.id}-prompt` }}>
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
      <Field
        label="Outcomes"
        htmlFor={`${node.id}-outcomes`}
        hint="Optional. The agent ends by picking one, and a branch step can route on it."
        {...{ 'data-testid': `playbook-field-${node.id}-outcomes` }}
      >
        {/* data-testid-exempt: its input, Add, and remove buttons carry their own ids. */}
        <OutcomesField
          id={`${node.id}-outcomes`}
          value={config.outcomes}
          disabled={disabled}
          onChange={(value) => setField('outcomes', value)}
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
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Notifications</span>
        <button
          type="button"
          role="switch"
          aria-checked={config.notifyApprovers === true}
          disabled={disabled}
          className={`${styles.choiceCard} ${config.notifyApprovers === true ? styles.choiceCardActive : ''}`}
          onClick={() => setField('notifyApprovers', config.notifyApprovers === true ? undefined : true)}
          {...{ 'data-testid': 'playbook-gate-notify-approvers' }}
        >
          {config.notifyApprovers === true ? <Bell size={15} aria-hidden /> : <BellOff size={15} aria-hidden />}
          <span className={styles.choiceText}>
            <span className={styles.choiceTitle}>
              {config.notifyApprovers === true ? 'Notify approvers' : 'Don\u2019t notify approvers'}
            </span>
            <span className={styles.choiceDescription}>
              {mode === 'group'
                ? 'When the step opens, everyone in the reviewer group gets an Apex notification and a Teams message.'
                : 'When the step opens, the run owner gets an Apex notification and a Teams message.'}
            </span>
          </span>
        </button>
      </div>
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

const BRANCH_TESTS: Record<PlaybookComparableKind, PlaybookPickerOption[]> = {
  choice: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'in', label: 'is one of' },
  ],
  text: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'contains', label: 'contains', description: 'Ignores capital letters' },
  ],
  number: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'gt', label: 'is more than' },
    { value: 'gte', label: 'is at least' },
    { value: 'lt', label: 'is less than' },
    { value: 'lte', label: 'is at most' },
  ],
  boolean: [{ value: 'eq', label: 'is' }],
};

const PRESENCE_TESTS: PlaybookPickerOption[] = [
  { value: 'exists', label: 'has a value' },
  { value: 'missing', label: 'is empty' },
];

function branchTestsFor(field: PlaybookComparableField): PlaybookPickerOption[] {
  return field.optional ? [...BRANCH_TESTS[field.kind], ...PRESENCE_TESTS] : BRANCH_TESTS[field.kind];
}

/** Tests that compare against nothing, a list, or one value. Switching shape resets the value. */
function testShape(operator: string | undefined): 'none' | 'list' | 'one' {
  if (operator === 'exists' || operator === 'missing') return 'none';
  return operator === 'in' ? 'list' : 'one';
}

function choiceLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/[_-]+/g, ' ');
}

/** The value box for a branch test, shaped by the field: a list, yes/no, a number, or text. */
const BranchValueField: React.FC<{
  id: string;
  field: PlaybookComparableField;
  operator: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}> = ({ id, field, operator, value, disabled, onChange }) => {
  const [numberText, setNumberText] = useState(typeof value === 'number' ? String(value) : '');
  if (field.kind === 'boolean') {
    return (
      <div className={styles.choiceCards} role="radiogroup" aria-label="Value">
        {([[true, 'Yes'], [false, 'No']] as const).map(([option, label]) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={value === option}
            disabled={disabled}
            className={`${styles.choiceCard} ${value === option ? styles.choiceCardActive : ''}`}
            onClick={() => onChange(option)}
            {...{ 'data-testid': `playbook-branch-value-${label.toLowerCase()}` }}
          >
            <span className={styles.choiceTitle}>{label}</span>
          </button>
        ))}
      </div>
    );
  }
  if (field.kind === 'choice' && operator === 'in') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <div className={styles.field} role="group" aria-label="Values">
        {field.choices.map((choice) => (
          <label key={choice} className={styles.checkOption}>
            <input
              type="checkbox"
              className={styles.fieldCheckbox}
              checked={selected.includes(choice)}
              disabled={disabled}
              onChange={(event) => onChange(
                event.target.checked
                  ? [...selected, choice]
                  : selected.filter((candidate) => candidate !== choice),
              )}
              {...{ 'data-testid': `playbook-branch-value-${choice}` }}
            />
            {choiceLabel(choice)}
          </label>
        ))}
      </div>
    );
  }
  if (field.kind === 'choice') {
    return (
      <PlaybookOptionPicker
        id={id}
        value={typeof value === 'string' ? value : undefined}
        options={field.choices.map((choice) => ({ value: choice, label: choiceLabel(choice) }))}
        placeholder="Choose a value"
        disabled={disabled}
        onChange={(next) => onChange(next)}
        {...{ 'data-testid': 'playbook-branch-value' }}
      />
    );
  }
  if (field.kind === 'number') {
    return (
      <input
        id={id}
        className={styles.fieldInput}
        inputMode="decimal"
        placeholder="A number"
        value={numberText}
        disabled={disabled}
        onChange={(event) => {
          setNumberText(event.target.value);
          const parsed = Number(event.target.value);
          onChange(event.target.value.trim() && Number.isFinite(parsed) ? parsed : undefined);
        }}
        {...{ 'data-testid': 'playbook-branch-value' }}
      />
    );
  }
  return (
    <input
      id={id}
      className={styles.fieldInput}
      placeholder={operator === 'contains' ? 'Words to look for' : 'The exact text to match'}
      value={typeof value === 'string' ? value : ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || undefined)}
      {...{ 'data-testid': 'playbook-branch-value' }}
    />
  );
};

function defaultBranchValue(field: PlaybookComparableField, operator: string): unknown {
  if (testShape(operator) === 'none') return undefined;
  if (field.kind === 'boolean') return true;
  if (field.kind === 'choice') return operator === 'in' ? [] : field.choices[0];
  return undefined;
}

const BranchFields: React.FC<PlaybookStepFieldsProps> = (props) => {
  const { node, config, disabled, setConfig, priorNodeIds, nextNodeIds, allNodes, paletteItems } = props;
  const condition = (config.condition && typeof config.condition === 'object' && !Array.isArray(config.condition)
    ? config.condition
    : {}) as Partial<PlaybookBranchCondition>;
  const label = (id: string) => {
    const found = allNodes.find((candidate) => candidate.id === id);
    return found ? stepDisplayName(found) : id;
  };
  const sources = priorNodeIds
    .map((id) => allNodes.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is PlaybookGraphNode => Boolean(candidate))
    .map((source) => ({
      node: source,
      fields: comparableOutputFields(paletteItems.find((item) => item.stepType === source.stepType), source),
    }))
    .filter((source) => source.fields.length > 0);
  const source = sources.find((candidate) => candidate.node.id === condition.sourceStepId);
  const field = source?.fields.find((candidate) => candidate.field === condition.field);
  const tests = field ? branchTestsFor(field) : [];
  const needsValue = testShape(condition.operator) !== 'none';

  const setCondition = (next: Partial<PlaybookBranchCondition>) => {
    setConfig({ ...config, condition: { ...condition, ...next } });
  };
  const chooseSource = (sourceStepId: string | undefined) => {
    const picked = sources.find((candidate) => candidate.node.id === sourceStepId);
    const firstField = picked?.fields[0];
    setConfig({
      ...config,
      condition: firstField
        ? { sourceStepId, field: firstField.field, operator: 'eq', value: defaultBranchValue(firstField, 'eq') }
        : { sourceStepId },
    });
  };
  const chooseField = (name: string | undefined) => {
    const picked = source?.fields.find((candidate) => candidate.field === name);
    setCondition({ field: name, operator: 'eq', value: picked ? defaultBranchValue(picked, 'eq') : undefined });
  };
  const chooseTest = (operator: string | undefined) => {
    const next = (operator ?? 'eq') as PlaybookBranchCondition['operator'];
    const switchesShape = testShape(next) !== testShape(condition.operator);
    setCondition({
      operator: next,
      ...(switchesShape && field ? { value: defaultBranchValue(field, next) } : {}),
    });
  };

  const destinations: PlaybookPickerOption[] = [
    ...nextNodeIds.map((id) => ({ value: id, label: label(id), description: 'Connected after this branch' })),
    ...allNodes
      .filter((candidate) => candidate.id !== node.id && !nextNodeIds.includes(candidate.id) && !priorNodeIds.includes(candidate.id))
      .map((candidate) => ({ value: candidate.id, label: stepDisplayName(candidate) })),
  ];

  return (
    <>
      <div className={styles.infoCard}>
        <GitBranch size={15} aria-hidden />
        <span>
          {source && field
            ? `If ${label(source.node.id)}'s ${field.label.toLowerCase()} ${tests.find((test) => test.value === condition.operator)?.label ?? 'is'}${
              !needsValue
                ? ''
                : ` ${Array.isArray(condition.value)
                  ? condition.value.map((choice) => choiceLabel(String(choice))).join(' or ') || '…'
                  : condition.value === undefined
                    ? '…'
                    : typeof condition.value === 'boolean'
                      ? (condition.value ? 'yes' : 'no')
                      : field.kind === 'choice' ? choiceLabel(String(condition.value)) : `"${String(condition.value)}"`}`
            }, the run goes one way. Otherwise it goes the other.`
            : 'Pick an earlier step and what to check in its result.'}
        </span>
      </div>
      <Field label="Check the result of" htmlFor={`${node.id}-source`} required {...{ 'data-testid': `playbook-field-${node.id}-source` }}>
        <PlaybookOptionPicker
          id={`${node.id}-source`}
          value={source ? source.node.id : undefined}
          options={sources.map((candidate) => ({ value: candidate.node.id, label: stepDisplayName(candidate.node) }))}
          placeholder={sources.length ? 'Choose an earlier step' : 'Connect a step before this branch first'}
          disabled={disabled || sources.length === 0}
          onChange={chooseSource}
          {...{ 'data-testid': 'playbook-branch-source' }}
        />
      </Field>
      {source ? (
        <Field label="What to check" htmlFor={`${node.id}-field`} required {...{ 'data-testid': `playbook-field-${node.id}-field` }}>
          <PlaybookOptionPicker
            id={`${node.id}-field`}
            value={field?.field}
            options={source.fields.map((candidate) => ({ value: candidate.field, label: candidate.label }))}
            placeholder="Choose what to check"
            disabled={disabled}
            onChange={chooseField}
            {...{ 'data-testid': 'playbook-branch-field' }}
          />
        </Field>
      ) : null}
      {field ? (
        <>
          <Field label="Test" htmlFor={`${node.id}-test`} required {...{ 'data-testid': `playbook-field-${node.id}-test` }}>
            <PlaybookOptionPicker
              id={`${node.id}-test`}
              value={typeof condition.operator === 'string' ? condition.operator : undefined}
              options={tests}
              placeholder="Choose a test"
              disabled={disabled || tests.length < 2}
              onChange={chooseTest}
              {...{ 'data-testid': 'playbook-branch-test' }}
            />
          </Field>
          {needsValue ? (
            <Field label="Value" htmlFor={`${node.id}-value`} required {...{ 'data-testid': `playbook-field-${node.id}-value` }}>
              {/* data-testid-exempt: each value control carries its own id. */}
              <BranchValueField
                key={`${field.field}-${testShape(condition.operator)}`}
                id={`${node.id}-value`}
                field={field}
                operator={typeof condition.operator === 'string' ? condition.operator : 'eq'}
                value={condition.value}
                disabled={disabled}
                onChange={(value) => setCondition({ value })}
              />
            </Field>
          ) : null}
        </>
      ) : null}
      {(['whenTrue', 'whenFalse'] as const).map((key) => (
        <Field
          key={key}
          label={key === 'whenTrue' ? 'If it matches, go to' : 'Otherwise, go to'}
          htmlFor={`${node.id}-${key}`}
          required
          {...{ 'data-testid': `playbook-field-${node.id}-${key}` }}
        >
          <PlaybookOptionPicker
            id={`${node.id}-${key}`}
            value={typeof config[key] === 'string' ? (config[key] as string) : undefined}
            options={destinations}
            placeholder="Choose a step"
            disabled={disabled}
            onChange={(value) => props.setField(key, value)}
            {...{ 'data-testid': `playbook-inspector-field-${key}` }}
          />
        </Field>
      ))}
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
  const models = useAvailableModels();
  const prompt = typeof config.prompt === 'string' ? config.prompt : '';
  const overridden = Boolean(config.workItemType || config.state || config.tags);
  const modelOptions: PlaybookPickerOption[] = (models.data ?? []).map((model) => ({
    value: model.id,
    label: model.displayName,
    description: model.id,
  }));
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
      <Field label="Model" htmlFor={`${node.id}-model`} hint="Blank uses the project's Cloud Agent model." {...{ 'data-testid': `playbook-field-${node.id}-model` }}>
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
          {...{ 'data-testid': "playbook-cloud-agent-field-model" }}
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
      description: agent ? `\${steps.${agent.id}.output}` : '',
    };
  }
  if (operation === 'post-ado-comment') {
    return {
      workItemId: creator ? `\${steps.${creator.id}.workItemId}` : '${input.workItemId}',
      text: agent ? `\${steps.${agent.id}.output}` : '',
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

const ConnectorFields: React.FC<PlaybookStepFieldsProps> = ({
  node,
  config,
  disabled,
  bindings,
  referencesFor,
  setConfig,
}) => {
  const integrationId = typeof config.integration === 'string' ? config.integration : PLAYBOOK_CONNECTORS[0].id;
  const connector = playbookConnector(integrationId) ?? PLAYBOOK_CONNECTORS[0];
  const operationId = typeof config.operation === 'string' ? config.operation : connector.operations[0].id;
  const operation = playbookConnectorOperation(connector.id, operationId) ?? connector.operations[0];
  const parameters = config.parameters && typeof config.parameters === 'object' && !Array.isArray(config.parameters)
    ? config.parameters as Record<string, unknown>
    : {};
  const integrationOptions: PlaybookPickerOption[] = PLAYBOOK_CONNECTORS.map((item) => ({
    value: item.id,
    label: item.label,
    description: item.description,
  }));
  const operationOptions: PlaybookPickerOption[] = connector.operations.map((item) => ({
    value: item.id,
    label: item.label,
    description: item.description,
  }));
  return (
    <>
      <Field
        label="Integration"
        htmlFor={`${node.id}-integration`}
        required
        hint="The system this connector names. A run records the choice and does not call the system yet."
        {...{ 'data-testid': `playbook-field-${node.id}-integration` }}
      >
        <PlaybookOptionPicker
          id={`${node.id}-integration`}
          value={connector.id}
          options={integrationOptions}
          placeholder="Choose an integration"
          searchPlaceholder="Search integrations"
          disabled={disabled}
          onChange={(value) => {
            const next = playbookConnector(value) ?? PLAYBOOK_CONNECTORS[0];
            setConfig({ integration: next.id, operation: next.operations[0].id, parameters: {} });
          }}
          {...{ 'data-testid': 'playbook-inspector-field-integration' }}
        />
      </Field>
      <Field
        label="Action"
        htmlFor={`${node.id}-operation`}
        required
        {...{ 'data-testid': `playbook-field-${node.id}-operation` }}
      >
        <PlaybookOptionPicker
          id={`${node.id}-operation`}
          value={operation.id}
          options={operationOptions}
          placeholder="Choose an action"
          searchPlaceholder="Search actions"
          disabled={disabled}
          onChange={(value) => setConfig({ ...config, operation: value, parameters: {} })}
          {...{ 'data-testid': 'playbook-inspector-field-operation' }}
        />
      </Field>
      {operation.fields.map((field) => {
        const value = typeof parameters[field.key] === 'string' ? parameters[field.key] as string : '';
        return (
          <Field
            key={field.key}
            label={field.label}
            htmlFor={`${node.id}-${field.key}`}
            hint={field.hint}
            {...{ 'data-testid': `playbook-field-${node.id}-${field.key}` }}
          >
            <PlaybookBindingText
              id={`${node.id}-${field.key}`}
              value={value}
              multiline={field.multiline}
              disabled={disabled}
              bindings={bindings}
              references={referencesFor(value)}
              onChange={(next) => setConfig({
                ...config,
                integration: connector.id,
                operation: operation.id,
                parameters: { ...parameters, [field.key]: next },
              })}
              {...{ 'data-testid': `playbook-inspector-field-${field.key}` }}
            />
          </Field>
        );
      })}
    </>
  );
};

export const STEP_FIELD_RENDERERS: Record<string, {
  handledKeys: readonly string[];
  Component: React.FC<PlaybookStepFieldsProps>;
}> = {
  'cursor-agent': {
    handledKeys: ['skillPath', 'prompt', 'model', 'mcpProfile', 'deadlineMs', 'threadId', 'outcomes'],
    Component: CursorAgentFields,
  },
  'approval-gate': {
    handledKeys: ['subject', 'approverPool', 'gatedStepId', 'deadlineMs', 'notifyApprovers'],
    Component: ApprovalGateFields,
  },
  branch: {
    handledKeys: ['condition', 'whenTrue', 'whenFalse'],
    Component: BranchFields,
  },
  'apex-action': {
    handledKeys: ['operation', 'parameters'],
    Component: ApexActionFields,
  },
  'cloud-agent': {
    handledKeys: ['workItemId', 'workItemSource', 'workItemType', 'state', 'tags', 'prompt', 'model', 'deadlineMs'],
    Component: CloudAgentFields,
  },
  connector: {
    handledKeys: ['integration', 'operation', 'parameters'],
    Component: ConnectorFields,
  },
};
