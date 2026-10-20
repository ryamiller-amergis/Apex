/**
 * Settings for the selected canvas step.
 *
 * Fields come from the step type's input JSON schema, so a new server step type gets a form without
 * a client change. Anything the form cannot express (nested objects, unions) is edited as JSON for
 * that field, and the whole config is always available as raw JSON.
 */
import React, { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type {
  PlaybookGraphNode,
  PlaybookStepTypePaletteItem,
} from '../../shared/types/playbook';
import { AI_SOURCE_STEP_TYPES, HUMAN_REVIEW_STEP_TYPES, stepMeta } from './playbookStepCatalog';
import styles from './PlaybookBuilder.module.css';

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
}

type Config = Record<string, unknown>;

/** Render with `key={node.id}` so per-field drafts reset when the selection changes. */
export interface PlaybookInspectorNodeRef {
  id: string;
  stepType: string;
}

interface PlaybookStepInspectorProps {
  node: PlaybookGraphNode;
  paletteItem: PlaybookStepTypePaletteItem | undefined;
  otherNodeIds: readonly string[];
  otherNodes?: readonly PlaybookInspectorNodeRef[];
  canAuthor: boolean;
  onChange: (config: Config) => void;
  onDelete: () => void;
  onClose: () => void;
  'data-testid'?: string;
}

/** Keys whose value names another node in the graph. */
const NODE_REFERENCE_KEYS = new Set([
  'whenTrue',
  'whenFalse',
  'gatedStepId',
  'reviewStepId',
  'feedbackStepId',
]);
const MULTILINE_KEYS = new Set(['prompt', 'body', 'reportMd']);

const FIELD_LABELS: Record<string, string> = {
  deadlineMs: 'Deadline (ms)',
  mcpProfile: 'MCP profile',
  gatedStepId: 'Gated step',
  reviewStepId: 'Review step',
  feedbackStepId: 'Feedback review',
  sourceStepIds: 'Selected AI steps',
  label: 'Label',
  whenTrue: 'When true, go to',
  whenFalse: 'When false, go to',
  recipientUserId: 'Recipient',
  reportMd: 'Report (Markdown)',
};

const FIELD_HINTS: Record<string, string> = {
  deadlineMs: 'Leave blank to use the step’s default.',
  recipientUserId: 'Leave blank to notify whoever started the run.',
  gatedStepId: 'The step this approval protects.',
  reviewStepId: 'Optional. Choose an earlier approval or feedback review.',
  feedbackStepId: 'Optional. Store the item choices from an earlier feedback review.',
  sourceStepIds: 'Choose the earlier AI steps. Only the ones you select are used.',
};

function humanize(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function schemaType(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type)
    ? schema.type.find((t) => t !== 'null')
    : schema.type;
}

interface FieldProps {
  id: string;
  name: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  otherNodeIds: readonly string[];
  otherNodes?: readonly PlaybookInspectorNodeRef[];
  onChange: (value: unknown) => void;
  'data-testid'?: string;
}

function choicesFor(
  name: string,
  otherNodeIds: readonly string[],
  otherNodes: readonly PlaybookInspectorNodeRef[] | undefined
): PlaybookInspectorNodeRef[] {
  if (!otherNodes) return otherNodeIds.map((id) => ({ id, stepType: '' }));
  if (name === 'sourceStepIds') {
    return otherNodes.filter((node) => AI_SOURCE_STEP_TYPES.has(node.stepType));
  }
  if (name === 'reviewStepId') {
    return otherNodes.filter((node) => HUMAN_REVIEW_STEP_TYPES.has(node.stepType));
  }
  if (name === 'feedbackStepId') {
    return otherNodes.filter((node) => node.stepType === 'feedback-review');
  }
  return [...otherNodes];
}

const NumberField: React.FC<FieldProps> = ({
  id,
  value,
  disabled,
  onChange,
  'data-testid': testId,
}) => {
  const [text, setText] = useState(
    typeof value === 'number' ? String(value) : ''
  );
  const [invalid, setInvalid] = useState(false);
  return (
    <>
      <input
        id={id}
        className={styles.fieldInput}
        inputMode="numeric"
        value={text}
        disabled={disabled}
        aria-invalid={invalid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (!next.trim()) {
            setInvalid(false);
            onChange(undefined);
            return;
          }
          const parsed = Number(next);
          setInvalid(!Number.isFinite(parsed));
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        data-testid={testId}
      />
      {invalid ? (
        <span className={styles.fieldError}>Enter a number.</span>
      ) : null}
    </>
  );
};

const JsonValueField: React.FC<FieldProps> = ({
  id,
  value,
  disabled,
  onChange,
  'data-testid': testId,
}) => {
  const [text, setText] = useState(
    value === undefined ? '' : JSON.stringify(value, null, 2)
  );
  const [invalid, setInvalid] = useState(false);
  return (
    <>
      <textarea
        id={id}
        className={`${styles.fieldInput} ${styles.fieldCode}`}
        rows={4}
        value={text}
        disabled={disabled}
        aria-invalid={invalid}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (!next.trim()) {
            setInvalid(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(next));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        data-testid={testId}
      />
      {invalid ? (
        <span className={styles.fieldError}>Not valid JSON yet.</span>
      ) : null}
    </>
  );
};

const SchemaField: React.FC<FieldProps> = (props) => {
  const { id, name, schema, value, disabled, otherNodeIds, otherNodes, onChange } = props;
  const testId = props['data-testid'] ?? `playbook-inspector-field-${name}`;
  const choices = choicesFor(name, otherNodeIds, otherNodes);

  if (name === 'sourceStepIds') {
    const selected = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return (
      <div
        id={id}
        className={styles.sourceList}
        role="group"
        aria-label="Selected AI steps"
        data-testid={testId}
      >
        {choices.length === 0 ? (
          <span className={styles.fieldHint}>Add an earlier AI step first.</span>
        ) : (
          choices.map((node) => (
            <label key={node.id} className={styles.sourceOption}>
              <input
                type="checkbox"
                className={styles.fieldCheckbox}
                checked={selected.includes(node.id)}
                disabled={disabled}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, node.id]
                    : selected.filter((entry) => entry !== node.id);
                  onChange(next.length > 0 ? next : undefined);
                }}
                {...{ 'data-testid': `playbook-inspector-source-${node.id}` }}
              />
              {node.id}
            </label>
          ))
        )}
      </div>
    );
  }

  if (NODE_REFERENCE_KEYS.has(name)) {
    return (
      <select
        id={id}
        className={styles.fieldInput}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        data-testid={testId}
      >
        <option value="">Choose a step…</option>
        {choices.map((node) => (
          <option key={node.id} value={node.id}>
            {node.id}
          </option>
        ))}
      </select>
    );
  }

  if (schema.enum) {
    return (
      <select
        id={id}
        className={styles.fieldInput}
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        data-testid={testId}
      >
        <option value="">Not set</option>
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  }

  const type = schemaType(schema);
  if (type === 'string') {
    const common = {
      id,
      className: styles.fieldInput,
      value: typeof value === 'string' ? value : '',
      disabled,
      onChange: (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
      ) => onChange(event.target.value === '' ? undefined : event.target.value),
    };
    return MULTILINE_KEYS.has(name) ? (
      <textarea rows={4} {...common} data-testid={testId} />
    ) : (
      <input {...common} data-testid={testId} />
    );
  }
  if (type === 'number' || type === 'integer')
    return <NumberField {...props} data-testid={testId} />;
  if (type === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        className={styles.fieldCheckbox}
        checked={value === true}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
      />
    );
  }
  return <JsonValueField {...props} data-testid={testId} />;
};

const ConfigJsonEditor: React.FC<{
  config: Config;
  disabled: boolean;
  onChange: (config: Config) => void;
  'data-testid': string;
}> = ({ config, disabled, onChange, 'data-testid': testId }) => {
  const [text, setText] = useState(JSON.stringify(config, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <textarea
        className={`${styles.fieldInput} ${styles.fieldCode} ${styles.jsonEditor}`}
        value={text}
        disabled={disabled}
        spellCheck={false}
        aria-label="Step config JSON"
        aria-invalid={Boolean(error)}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed: unknown = JSON.parse(next);
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              Array.isArray(parsed)
            ) {
              setError('Config must be a JSON object.');
              return;
            }
            setError(null);
            onChange(parsed as Config);
          } catch {
            setError('Not valid JSON yet.');
          }
        }}
        data-testid={testId}
      />
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </>
  );
};

export const PlaybookStepInspector: React.FC<PlaybookStepInspectorProps> = ({
  node,
  paletteItem,
  otherNodeIds,
  otherNodes,
  canAuthor,
  onChange,
  onDelete,
  onClose,
  'data-testid': testId = 'playbook-step-inspector',
}) => {
  const meta = stepMeta(node.stepType);
  const Icon = meta.icon;
  const config = node.config ?? {};
  const schema = (paletteItem?.inputJsonSchema ?? {}) as JsonSchema;
  const properties = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const [mode, setMode] = useState<'form' | 'json'>(
    properties.length ? 'form' : 'json'
  );

  const setField = (key: string, value: unknown) => {
    const next: Config = { ...config };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <aside
      className={styles.inspector}
      aria-label={`${meta.title} settings`}
      {...{ 'data-testid': testId, 'data-group': meta.group }}
    >
      <header className={styles.inspectorHeader}>
        <span className={styles.stepGlyph} aria-hidden>
          <Icon size={16} />
        </span>
        <div className={styles.inspectorTitleBlock}>
          <h2 className={styles.inspectorTitle}>{meta.title}</h2>
          <code className={styles.inspectorId} title="Step id">
            {node.id}
          </code>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onClose}
          aria-label="Close settings"
          {...{ 'data-testid': 'playbook-inspector-close' }}
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className={styles.segmented} role="tablist" aria-label="Edit mode">
        {(['form', 'json'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={`${styles.segment} ${mode === value ? styles.segmentActive : ''}`}
            disabled={value === 'form' && properties.length === 0}
            onClick={() => setMode(value)}
            {...{ 'data-testid': `playbook-inspector-mode-${value}` }}
          >
            {value === 'form' ? 'Fields' : 'JSON'}
          </button>
        ))}
      </div>

      <div className={styles.inspectorBody}>
        {mode === 'json' ? (
          <ConfigJsonEditor
            key={`${node.id}-json`}
            config={config}
            disabled={!canAuthor}
            onChange={onChange}
            data-testid="playbook-canvas-config"
          />
        ) : (
          properties.map(([key, fieldSchema]) => {
            const fieldId = `playbook-field-${node.id}-${key}`;
            return (
              <div key={`${node.id}-${key}`} className={styles.field}>
                <label htmlFor={fieldId} className={styles.fieldLabel}>
                  {humanize(key)}
                  {required.has(key) ? (
                    <span
                      className={styles.fieldRequired}
                      aria-label="required"
                    >
                      *
                    </span>
                  ) : null}
                </label>
                <SchemaField
                  id={fieldId}
                  name={key}
                  schema={fieldSchema}
                  value={config[key]}
                  disabled={!canAuthor}
                  otherNodeIds={otherNodeIds}
                  otherNodes={otherNodes}
                  onChange={(value) => setField(key, value)}
                  data-testid={`playbook-inspector-field-${key}`}
                />
                {FIELD_HINTS[key] ? (
                  <span className={styles.fieldHint}>{FIELD_HINTS[key]}</span>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {canAuthor ? (
        <footer className={styles.inspectorFooter}>
          <button
            type="button"
            className={styles.dangerGhost}
            onClick={onDelete}
            {...{ 'data-testid': 'playbook-inspector-delete' }}
          >
            <Trash2 size={14} aria-hidden /> Delete step
          </button>
        </footer>
      ) : null}
    </aside>
  );
};

export default PlaybookStepInspector;
