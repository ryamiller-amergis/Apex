/**
 * Settings for the selected canvas step.
 *
 * The common step types have hand-built fields (`PlaybookStepFields`). Every other field comes from
 * the step type's input JSON schema, so a new server step type gets a form without a client change.
 * Anything the form cannot express (nested objects, unions) is edited as JSON for that field, and
 * the whole config is always available as raw JSON.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Link2, Maximize2, Minimize2, Trash2, X } from 'lucide-react';
import type { PlaybookGraphNode, PlaybookStepTypePaletteItem } from '../../shared/types/playbook';
import { availableBindings, tokenReferences } from '../utils/playbookBindings';
import { PlaybookBindingText } from './PlaybookBindingText';
import { DeadlineField, STEP_FIELD_RENDERERS } from './PlaybookStepFields';
import { stepMeta } from './playbookStepCatalog';
import styles from './PlaybookBuilder.module.css';

const WIDTH_STORAGE_KEY = 'apex.playbooks.inspectorWidth';
const DEFAULT_WIDTH = 380;
const EXPANDED_WIDTH = 680;
const MIN_WIDTH = 300;

function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.min(960, window.innerWidth - 160));
}

function readWidth(): number {
  const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= MIN_WIDTH ? Math.min(stored, maxWidth()) : DEFAULT_WIDTH;
}

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
}

type Config = Record<string, unknown>;

/** Render with `key={node.id}` so per-field drafts reset when the selection changes. */
interface PlaybookStepInspectorProps {
  project: string;
  node: PlaybookGraphNode;
  paletteItem: PlaybookStepTypePaletteItem | undefined;
  otherNodeIds: readonly string[];
  /** Earlier steps, nearest first. */
  priorNodeIds: readonly string[];
  /** Steps this one connects straight to. */
  nextNodeIds?: readonly string[];
  allNodes: readonly PlaybookGraphNode[];
  paletteItems: readonly PlaybookStepTypePaletteItem[];
  canAuthor: boolean;
  onChange: (config: Config) => void;
  onDelete: () => void;
  onClose: () => void;
  'data-testid'?: string;
}

/** Keys whose value names another node in the graph. */
const NODE_REFERENCE_KEYS = new Set(['whenTrue', 'whenFalse', 'gatedStepId']);
const MULTILINE_KEYS = new Set(['prompt', 'body', 'reportMd', 'description', 'text']);

const FIELD_LABELS: Record<string, string> = {
  deadlineMs: 'Deadline (ms)',
  mcpProfile: 'MCP profile',
  gatedStepId: 'Gated step',
  whenTrue: 'When true, go to',
  whenFalse: 'When false, go to',
  recipientUserId: 'Recipient',
  reportMd: 'Report (Markdown)',
};

const FIELD_HINTS: Record<string, string> = {
  deadlineMs: 'Leave blank to use the stepâ€™s default.',
  recipientUserId: 'Leave blank to notify whoever started the run.',
  gatedStepId: 'The step this approval protects.',
};

function humanize(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function schemaType(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
}

interface FieldProps {
  id: string;
  name: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  otherNodeIds: readonly string[];
  onChange: (value: unknown) => void;
  binding?: Pick<React.ComponentProps<typeof PlaybookBindingText>, 'bindings' | 'references'>;
  'data-testid'?: string;
}

const NumberField: React.FC<FieldProps> = ({ id, value, disabled, onChange, 'data-testid': testId }) => {
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '');
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
        {...{ 'data-testid': testId }}
      />
      {invalid ? <span className={styles.fieldError}>Enter a number.</span> : null}
    </>
  );
};

const JsonValueField: React.FC<FieldProps> = ({ id, value, disabled, onChange, 'data-testid': testId }) => {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
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
        {...{ 'data-testid': testId }}
      />
      {invalid ? <span className={styles.fieldError}>Not valid JSON yet.</span> : null}
    </>
  );
};

const SchemaField: React.FC<FieldProps> = (props) => {
  const { id, name, schema, value, disabled, otherNodeIds, onChange } = props;
  const testId = props['data-testid'] ?? `playbook-inspector-field-${name}`;

  if (NODE_REFERENCE_KEYS.has(name)) {
    return (
      <select
        id={id}
        className={styles.fieldInput}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        {...{ 'data-testid': testId }}
      >
        <option value="">Choose a stepâ€¦</option>
        {otherNodeIds.map((nodeId) => (
          <option key={nodeId} value={nodeId}>{nodeId}</option>
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
        {...{ 'data-testid': testId }}
      >
        <option value="">Not set</option>
        {schema.enum.map((option) => (
          <option key={String(option)} value={String(option)}>{String(option)}</option>
        ))}
      </select>
    );
  }

  if (name === 'deadlineMs') {
    return <DeadlineField id={id} value={value} disabled={disabled} onChange={onChange} {...{ 'data-testid': testId }} />;
  }

  const type = schemaType(schema);
  if (type === 'string' && props.binding) {
    return (
      <PlaybookBindingText
        id={id}
        value={typeof value === 'string' ? value : ''}
        multiline={MULTILINE_KEYS.has(name)}
        disabled={disabled}
        bindings={props.binding.bindings}
        references={props.binding.references}
        onChange={onChange}
        {...{ 'data-testid': testId }}
      />
    );
  }
  if (type === 'string') {
    const common = {
      id,
      className: styles.fieldInput,
      value: typeof value === 'string' ? value : '',
      disabled,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.target.value === '' ? undefined : event.target.value),
    };
    return MULTILINE_KEYS.has(name)
      ? <textarea rows={4} {...common} {...{ 'data-testid': testId }} />
      : <input {...common} {...{ 'data-testid': testId }} />;
  }
  if (type === 'number' || type === 'integer') return <NumberField {...props} {...{ 'data-testid': testId }} />;
  if (type === 'boolean') {
    return (
      <input
        id={id}
        type="checkbox"
        className={styles.fieldCheckbox}
        checked={value === true}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        {...{ 'data-testid': testId }}
      />
    );
  }
  return <JsonValueField {...props} {...{ 'data-testid': testId }} />;
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
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              setError('Config must be a JSON object.');
              return;
            }
            setError(null);
            onChange(parsed as Config);
          } catch {
            setError('Not valid JSON yet.');
          }
        }}
        {...{ 'data-testid': testId }}
      />
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </>
  );
};

/** Drag the left edge to resize; the expand button toggles a wide layout; collapse keeps the header. */
function useInspectorWidth() {
  const [width, setWidth] = useState(readWidth);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const persist = useCallback((next: number) => {
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
    } catch {
      // Storage can be blocked; the width then lasts for this page only.
    }
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!drag.current) return;
      const next = drag.current.startWidth + (drag.current.startX - event.clientX);
      setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth(), next)));
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.removeProperty('user-select');
      setWidth((current) => {
        persist(current);
        return current;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [persist]);

  const startDrag = (event: React.PointerEvent) => {
    drag.current = { startX: event.clientX, startWidth: width };
    document.body.style.userSelect = 'none';
  };
  const expanded = width >= EXPANDED_WIDTH - 1;
  const toggleExpanded = () => {
    const next = expanded ? DEFAULT_WIDTH : Math.min(EXPANDED_WIDTH, maxWidth());
    setWidth(next);
    persist(next);
    setCollapsed(false);
  };
  const nudge = (delta: number) => {
    const next = Math.max(MIN_WIDTH, Math.min(maxWidth(), width + delta));
    setWidth(next);
    persist(next);
  };
  return { width, collapsed, setCollapsed, expanded, toggleExpanded, startDrag, nudge };
}

export const PlaybookStepInspector: React.FC<PlaybookStepInspectorProps> = ({
  project,
  node,
  paletteItem,
  otherNodeIds,
  priorNodeIds,
  nextNodeIds = [],
  allNodes,
  paletteItems,
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
  const custom = STEP_FIELD_RENDERERS[node.stepType];
  const [mode, setMode] = useState<'form' | 'json'>(properties.length || custom ? 'form' : 'json');
  const layout = useInspectorWidth();

  const bindings = useMemo(
    () => availableBindings(priorNodeIds, allNodes, paletteItems),
    [priorNodeIds, allNodes, paletteItems],
  );
  const referencesFor = useCallback(
    (text: string) => tokenReferences(text, priorNodeIds, allNodes, paletteItems),
    [priorNodeIds, allNodes, paletteItems],
  );
  const reads = referencesFor(JSON.stringify(config));

  const setField = (key: string, value: unknown) => {
    const next: Config = { ...config };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  const genericProperties = custom
    ? properties.filter(([key]) => !custom.handledKeys.includes(key))
    : properties;
  const genericFields = genericProperties.map(([key, fieldSchema]) => {
    const fieldId = `playbook-field-${node.id}-${key}`;
    const text = typeof config[key] === 'string' ? (config[key] as string) : '';
    return (
      <div key={`${node.id}-${key}`} className={styles.field}>
        <label htmlFor={fieldId} className={styles.fieldLabel}>
          {humanize(key)}
          {required.has(key) ? <span className={styles.fieldRequired} aria-label="required">*</span> : null}
        </label>
        <SchemaField
          id={fieldId}
          name={key}
          schema={fieldSchema}
          value={config[key]}
          disabled={!canAuthor}
          otherNodeIds={otherNodeIds}
          onChange={(value) => setField(key, value)}
          binding={{ bindings, references: referencesFor(text) }}
          {...{ 'data-testid': `playbook-inspector-field-${key}` }}
        />
        {FIELD_HINTS[key] ? <span className={styles.fieldHint}>{FIELD_HINTS[key]}</span> : null}
      </div>
    );
  });

  return (
    <aside
      className={`${styles.inspector} ${layout.collapsed ? styles.inspectorCollapsed : ''}`}
      style={{ width: layout.width }}
      aria-label={`${meta.title} settings`}
      {...{ 'data-testid': testId, 'data-group': meta.group }}
    >
      <button
        type="button"
        className={styles.resizeHandle}
        aria-label="Resize settings panel. Use the left and right arrow keys."
        onPointerDown={layout.startDrag}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') layout.nudge(24);
          if (event.key === 'ArrowRight') layout.nudge(-24);
        }}
        {...{ 'data-testid': "playbook-inspector-resize" }}
      />
      <header className={styles.inspectorHeader}>
        <span className={styles.stepGlyph} aria-hidden>
          <Icon size={16} />
        </span>
        <div className={styles.inspectorTitleBlock}>
          <h2 className={styles.inspectorTitle}>{meta.title}</h2>
          <code className={styles.inspectorId} title="Step id">{node.id}</code>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={layout.toggleExpanded}
          aria-label={layout.expanded ? 'Make settings narrower' : 'Make settings wider'}
          title={layout.expanded ? 'Narrower' : 'Wider'}
          {...{ 'data-testid': 'playbook-inspector-expand' }}
        >
          {layout.expanded ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => layout.setCollapsed((current) => !current)}
          aria-label={layout.collapsed ? 'Show settings' : 'Hide settings'}
          aria-expanded={!layout.collapsed}
          title={layout.collapsed ? 'Show' : 'Minimize'}
          {...{ 'data-testid': 'playbook-inspector-collapse' }}
        >
          {layout.collapsed ? <ChevronDown size={16} aria-hidden /> : <ChevronUp size={16} aria-hidden />}
        </button>
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

      {layout.collapsed ? null : (
        <>
          <div className={styles.segmented} role="tablist" aria-label="Edit mode">
            {(['form', 'json'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                className={`${styles.segment} ${mode === value ? styles.segmentActive : ''}`}
                disabled={value === 'form' && properties.length === 0 && !custom}
                onClick={() => setMode(value)}
                {...{ 'data-testid': `playbook-inspector-mode-${value}` }}
              >
                {value === 'form' ? 'Fields' : 'JSON'}
              </button>
            ))}
          </div>

          <div className={styles.inspectorBody}>
            {reads.length > 0 ? (
              <section className={styles.readsCard} {...{ 'data-testid': "playbook-inspector-reads" }}>
                <span className={styles.readsTitle}>
                  <Link2 size={13} aria-hidden /> Uses data from
                </span>
                <ul className={styles.readsList}>
                  {reads.map((reference) => (
                    <li
                      key={reference.token}
                      className={reference.valid ? styles.readsItem : `${styles.readsItem} ${styles.readsItemInvalid}`}
                      title={reference.token}
                    >
                      <span>{reference.label}</span>
                      <span className={styles.readsState}>
                        {reference.valid ? 'ready' : 'not available before this step'}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className={styles.fieldHint}>
                  A step can use the output of any step that finishes before it. An approval in
                  between only pauses the run; the data is still there afterwards.
                </p>
              </section>
            ) : null}
            {mode === 'json' ? (
              <ConfigJsonEditor
                key={`${node.id}-json`}
                config={config}
                disabled={!canAuthor}
                onChange={onChange}
                {...{ 'data-testid': "playbook-canvas-config" }}
              />
            ) : (
              <>
                {custom ? (
                  <custom.Component
                    project={project}
                    node={node}
                    config={config}
                    disabled={!canAuthor}
                    priorNodeIds={priorNodeIds}
                    nextNodeIds={nextNodeIds}
                    allNodes={allNodes}
                    paletteItems={paletteItems}
                    bindings={bindings}
                    referencesFor={referencesFor}
                    setField={setField}
                    setConfig={onChange}
                  />
                ) : null}
                {custom && genericFields.length ? (
                  <details className={styles.moreSettings}>
                    <summary {...{ 'data-testid': "playbook-inspector-more" }}>More settings</summary>
                    {genericFields}
                  </details>
                ) : genericFields}
              </>
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
        </>
      )}
    </aside>
  );
};

export default PlaybookStepInspector;

