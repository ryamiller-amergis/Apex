/**
 * The project skill library: skills this project wrote for Playbook agent steps. Base skills ship
 * with Apex and are only picked in the builder, so they are not listed here.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Bot,
  FileText,
  Loader2,
  MessagesSquare,
  Paperclip,
  PenLine,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import { useAppShell } from '../hooks/useAppShell';
import {
  extractSkillFileText,
  useGenerateProjectSkillDraft,
  useProjectSkillLibrary,
  useProjectConnectorWrites,
  useProjectSkillTools,
  useSetProjectConnectorWrites,
  useSaveProjectSkill,
  useSetProjectSkillTools,
  useSkillDraftModels,
} from '../hooks/useProjectSkillLibrary';
import { DataGridFilterPills, DataGridToolbar } from './DataGridToolbar';
import { absoluteTime, relativeTime } from './playbookStatusFormat';
import pageStyles from './PlaybooksManagePage.module.css';
import styles from './ProjectSkillLibraryPage.module.css';
import {
  MAX_CONVERTED_FILE_BYTES,
  MAX_SKILL_FILE_BYTES,
  decodeSkillFileText,
  filterProjectSkills,
  isConvertedFileName,
  skillFileName,
  skillNameFromTitle,
  type ProjectSkillLibraryItem,
  type ProjectSkillType,
} from '../utils/projectSkillLibrary';
import { blankSkillFile, readSkillFile as readSkillFields, updateSkillFile } from '../utils/skillFile';

type TypeFilter = 'all' | ProjectSkillType;

const FILTER_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'Autonomous', value: 'autonomous' },
  { label: 'Interactive', value: 'interactive' },
] as const;

const SKILL_TYPES: { value: ProjectSkillType; label: string; hint: string; icon: typeof Bot }[] = [
  {
    value: 'autonomous',
    label: 'Autonomous',
    hint: 'Runs on its own and returns a result.',
    icon: Bot,
  },
  {
    value: 'interactive',
    label: 'Interactive',
    hint: 'Chats with a person in the run, who approves the result.',
    icon: MessagesSquare,
  },
];

interface AttachedFile {
  path: string;
  content: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function readSkillFile(project: string, file: File): Promise<AttachedFile> {
  const path = skillFileName(file.name);
  if (!path) throw new Error(`"${file.name}" needs a name with a file extension.`);
  if (isConvertedFileName(path)) {
    if (file.size > MAX_CONVERTED_FILE_BYTES) throw new Error(`"${file.name}" is over 5 MB.`);
    const extracted = await extractSkillFileText(project, {
      fileName: path,
      base64: await readAsBase64(file),
    });
    return { path: extracted.fileName, content: extracted.content };
  }
  if (file.size > MAX_SKILL_FILE_BYTES) throw new Error(`"${file.name}" is over 1 MB.`);
  const content = decodeSkillFileText(await file.arrayBuffer());
  if (content === null) {
    throw new Error(`"${file.name}" is not a text file. Attach text, Word, or PDF files.`);
  }
  if (!content.trim()) throw new Error(`"${file.name}" is empty.`);
  return { path, content };
}

function useEscape(onClose: () => void) {
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latest.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

// ── Write dialog ─────────────────────────────────────────────────────────────

interface SkillEditorSeed {
  title: string;
  /** The whole SKILL.md, frontmatter included. */
  content: string;
  files: AttachedFile[];
}

const EMPTY_SEED: SkillEditorSeed = {
  title: '',
  content: blankSkillFile(),
  files: [],
};

const SkillEditor: React.FC<{
  project: string;
  seed: SkillEditorSeed;
  editing: boolean;
  onClose: () => void;
}> = ({ project, seed, editing, onClose }) => {
  const saveSkill = useSaveProjectSkill(project);
  const generate = useGenerateProjectSkillDraft(project);
  const tools = useProjectSkillTools(project);
  const [title, setTitle] = useState(seed.title);
  // The file is the one source of truth. Description, type and tools are read from its frontmatter
  // and written back to it, so what the person sees is what is saved.
  const [content, setContent] = useState(seed.content);
  const file = useMemo(() => readSkillFields(content), [content]);
  const description = file.description;
  const skillType: ProjectSkillType = file.skillType ?? 'autonomous';
  const instructions = file.body;
  const allowedTools = useMemo(() => new Set(tools.data?.allowed ?? []), [tools.data]);
  const [request, setRequest] = useState('');
  const [draftModelId, setDraftModelId] = useState('');
  const draftModels = useSkillDraftModels(project);
  const [pendingDraft, setPendingDraft] = useState<{ description: string; instructions: string } | null>(null);
  const [files, setFiles] = useState<AttachedFile[]>(seed.files);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Shown inside the Draft with AI panel, next to the button that caused it. */
  const [aiError, setAiError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const slug = skillNameFromTitle(title);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  useEscape(onClose);

  async function onGenerate() {
    setAiError(null);
    if (!slug) {
      setAiError('Give the skill a title before generating a draft.');
      return;
    }
    if (!request.trim()) {
      setAiError('Say what the skill should do before generating a draft.');
      return;
    }
    try {
      const draft = await generate.mutateAsync({
        title,
        skillType,
        request,
        ...(draftModelId ? { modelId: draftModelId } : {}),
      });
      if (!description.trim() && !instructions.trim()) {
        setContent((current) => updateSkillFile(current, { description: draft.description, body: draft.instructions }));
      } else {
        setPendingDraft(draft);
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'The draft could not be generated.');
    }
  }

  async function onPickFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setReadingFiles(true);
    const errors: string[] = [];
    const read: AttachedFile[] = [];
    for (const file of Array.from(list)) {
      try {
        read.push(await readSkillFile(project, file));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : `"${file.name}" could not be read.`);
      }
    }
    setFiles((current) => {
      const byPath = new Map(current.map((file) => [file.path, file]));
      for (const file of read) byPath.set(file.path, file);
      return [...byPath.values()];
    });
    setFileErrors(errors);
    setReadingFiles(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!slug) {
      setError('The title needs at least one letter or number.');
      return;
    }
    if (!description.trim() || !instructions.trim()) {
      setError('A description and instructions are required.');
      return;
    }
    if (!file.skillType) {
      setError('The skill file needs a type under metadata.apex.skill-type: autonomous or interactive.');
      return;
    }
    try {
      await saveSkill.mutateAsync({
        // The title decides the name, so the name line always matches the library entry.
        content: updateSkillFile(content, { name: slug }),
        companions: files.map((file) => ({ ...file, classification: 'reference' as const })),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The skill could not be saved.');
    }
  }

  return (
    <div className={pageStyles.overlay} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className={`${pageStyles.dialog} ${styles.wideDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-dialog-title"
        onSubmit={(event) => void onSave(event)}
        data-testid="skill-library-form"
      >
        <header className={pageStyles.dialogHeader}>
          <div>
            <h2 id="skill-dialog-title" className={pageStyles.dialogTitle}>
              {editing ? `New version of ${seed.title}` : 'Write a skill'}
            </h2>
            <p className={styles.dialogHint}>
              A skill is the instructions an agent step follows. Saving publishes a new version.
            </p>
          </div>
          <button
            type="button"
            className={pageStyles.iconButton}
            onClick={onClose}
            aria-label="Close"
            data-testid="skill-library-close"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className={styles.dialogBody}>
          <label className={pageStyles.formField}>
            <span>Title</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setContent((current) => updateSkillFile(current, { name: skillNameFromTitle(event.target.value) }));
              }}
              placeholder="e.g. Release notes writer"
              readOnly={editing}
              data-testid="skill-library-title"
            />
            <em>{slug ? `Saved as ${slug}` : 'The title becomes the skill name.'}</em>
          </label>

          <fieldset className={styles.typeChoices}>
            <legend>Type</legend>
            {SKILL_TYPES.map(({ value, label, hint, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={skillType === value}
                className={styles.typeChoice}
                data-active={skillType === value}
                onClick={() => setContent((current) => updateSkillFile(current, { skillType: value }))}
                data-testid={`skill-library-type-${value}`}
              >
                <Icon size={16} aria-hidden />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </button>
            ))}
          </fieldset>

          <section className={styles.aiPanel} aria-labelledby="skill-ai-title">
            <h3 id="skill-ai-title" className={styles.aiTitle}>
              <Sparkles size={15} aria-hidden /> Draft with AI
            </h3>
            <p className={styles.aiHint}>
              Describe what the skill should do. The draft fills the description and instructions
              for you to edit. Nothing is saved until you save.
            </p>
            <textarea
              rows={2}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="e.g. Read the merged pull requests since the last release and write customer-facing release notes."
              aria-label="What should this skill do?"
              data-testid="skill-library-ai-request"
            />
            <div className={styles.aiActions}>
              <select
                className={styles.modelSelect}
                value={draftModelId}
                onChange={(event) => setDraftModelId(event.target.value)}
                disabled={generate.isPending}
                aria-label="Model for the draft"
                title="Model that writes the draft"
                data-testid="skill-library-ai-model"
              >
                <option value="">Default model</option>
                {(draftModels.data ?? []).map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </select>
              <button
                type="button"
                className={pageStyles.secondaryButton}
                onClick={() => void onGenerate()}
                disabled={generate.isPending}
                data-testid="skill-library-ai-generate"
              >
                {generate.isPending ? (
                  <><Loader2 size={15} className={styles.spin} aria-hidden /> Drafting…</>
                ) : (
                  <><Sparkles size={15} aria-hidden /> Generate draft</>
                )}
              </button>
              {generate.isPending ? (
                <span className={styles.aiStatus} role="status">You can keep editing while the draft runs.</span>
              ) : null}
            </div>
            {aiError ? (
              <div className={styles.aiError} role="alert" data-testid="skill-library-ai-error">
                <AlertTriangle size={16} className={styles.aiErrorIcon} aria-hidden />
                <div className={styles.aiErrorText}>
                  <strong>Could not draft the skill</strong>
                  <span>{aiError}</span>
                </div>
                <button
                  type="button"
                  className={styles.aiErrorDismiss}
                  onClick={() => setAiError(null)}
                  aria-label="Dismiss the error"
                  data-testid="skill-library-ai-error-dismiss"
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
            ) : null}
            {pendingDraft ? (
              <div className={styles.draftReady} role="status" data-testid="skill-library-ai-ready">
                <span>A draft is ready. It will replace the description and instructions below.</span>
                <div className={styles.aiActions}>
                  <button
                    type="button"
                    className={pageStyles.primaryButton}
                    onClick={() => {
                      setContent((current) => updateSkillFile(current, {
                        description: pendingDraft.description,
                        body: pendingDraft.instructions,
                      }));
                      setPendingDraft(null);
                    }}
                    data-testid="skill-library-ai-apply"
                  >
                    Use this draft
                  </button>
                  <button
                    type="button"
                    className={pageStyles.secondaryButton}
                    onClick={() => setPendingDraft(null)}
                    data-testid="skill-library-ai-discard"
                  >
                    Discard
                  </button>
                </div>
              </div>
            ) : null}
          </section>

          <label className={pageStyles.formField}>
            <span>Description</span>
            <input
              value={description}
              onChange={(event) => setContent((current) => updateSkillFile(current, { description: event.target.value }))}
              placeholder="One sentence on what the skill does and when to pick it"
              data-testid="skill-library-description"
            />
          </label>

          {(tools.data?.catalog.length ?? 0) > 0 ? (
            <fieldset className={styles.tools} data-testid="skill-library-tools">
              <legend>Tools <em>optional</em></legend>
              <p className={styles.toolsHint}>
                Extra tools the agent may use while it works. Choosing one writes{' '}
                <code>playbook-capabilities</code> in the skill file below. A platform admin decides
                which tools {project} allows.
              </p>
              {tools.data?.catalog.map((tool) => {
                const checked = file.tools.includes(tool.id);
                const allowed = allowedTools.has(tool.id);
                return (
                  <label
                    key={tool.id}
                    className={styles.tool}
                    data-disabled={!allowed && !checked}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!allowed && !checked}
                      onChange={(event) => {
                        const on = event.target.checked;
                        setContent((current) => {
                          const now = readSkillFields(current).tools.filter((id) => id !== tool.id);
                          return updateSkillFile(current, { tools: on ? [...now, tool.id] : now });
                        });
                      }}
                      data-testid={`skill-library-tool-${tool.id}`}
                    />
                    <strong>{tool.label}</strong>
                    <small>
                      {tool.description}
                      {!allowed ? ` Not enabled for ${project}.` : ''}
                    </small>
                  </label>
                );
              })}
            </fieldset>
          ) : null}

          <label className={pageStyles.formField}>
            <span>Skill file</span>
            <textarea
              className={styles.instructions}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
              placeholder="The whole SKILL.md."
              data-testid="skill-library-body"
            />
            <em>
              The whole SKILL.md: the frontmatter between the dashes, then the instructions in
              Markdown. The fields above edit the frontmatter for you.
            </em>
          </label>

          <div className={styles.filesField}>
            <div className={styles.filesHeader}>
              <div>
                <span className={styles.filesLabel}>Reference files <em>optional</em></span>
                <p className={styles.filesHint}>
                  Files the agent can read while it works, such as a catalog or a style guide. Any
                  text file, Word document, or PDF, up to 1 MB of text each. The agent reads the
                  whole file on every run, so attach only what it needs.
                </p>
              </div>
              <button
                type="button"
                className={pageStyles.secondaryButton}
                onClick={() => fileInputRef.current?.click()}
                disabled={readingFiles}
                data-testid="skill-library-attach"
              >
                {readingFiles ? (
                  <><Loader2 size={15} className={styles.spin} aria-hidden /> Reading…</>
                ) : (
                  <><Paperclip size={15} aria-hidden /> Attach files</>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => void onPickFiles(event.target.files)}
                data-testid="skill-library-file-input"
              />
            </div>
            {files.length > 0 ? (
              <ul className={styles.fileList} data-testid="skill-library-files">
                {files.map((file) => (
                  <li key={file.path} className={styles.fileChip}>
                    <FileText size={14} aria-hidden />
                    <span className={styles.fileName}>{file.path}</span>
                    <span className={styles.fileSize}>{formatBytes(new Blob([file.content]).size)}</span>
                    <button
                      type="button"
                      className={styles.fileRemove}
                      onClick={() => setFiles((current) => current.filter((item) => item.path !== file.path))}
                      aria-label={`Remove ${file.path}`}
                      data-testid={`skill-library-file-remove-${file.path}`}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {fileErrors.map((message) => (
              <p key={message} className={pageStyles.formError} role="alert">{message}</p>
            ))}
          </div>
        </div>

        {error ? <p className={pageStyles.formError} role="alert">{error}</p> : null}
        <footer className={pageStyles.dialogFooter}>
          <button
            type="button"
            className={pageStyles.secondaryButton}
            onClick={onClose}
            data-testid="skill-library-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={pageStyles.primaryButton}
            disabled={saveSkill.isPending || readingFiles}
            data-testid="skill-library-save"
          >
            {saveSkill.isPending ? 'Saving…' : 'Save skill'}
          </button>
        </footer>
      </form>
    </div>
  );
};

// ── Versions dialog ──────────────────────────────────────────────────────────

const SkillVersions: React.FC<{
  skill: ProjectSkillLibraryItem;
  canManage: boolean;
  onEdit: () => void;
  onClose: () => void;
}> = ({ skill, canManage, onEdit, onClose }) => {
  useEscape(onClose);

  return (
    <div className={pageStyles.overlay} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={`${pageStyles.dialog} ${styles.wideDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-versions-title"
        data-testid="skill-library-versions"
      >
        <header className={pageStyles.dialogHeader}>
          <div>
            <h2 id="skill-versions-title" className={pageStyles.dialogTitle}>{skill.name}</h2>
            <p className={styles.dialogHint}>{skill.description || 'No description.'}</p>
          </div>
          <button
            type="button"
            className={pageStyles.iconButton}
            onClick={onClose}
            aria-label="Close"
            data-testid="skill-library-versions-close"
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <ol className={`${styles.dialogBody} ${styles.versionList}`}>
          {skill.versions.map((version, index) => (
            <li key={version.id} className={styles.version}>
              <div className={styles.versionHead}>
                <span className={pageStyles.stateBadge} data-state={version.status}>
                  v{version.versionNumber}
                </span>
                <span className={styles.versionMeta}>
                  {version.skillType === 'interactive' ? 'Interactive' : 'Autonomous'}
                  {' · '}
                  <time dateTime={version.createdAt} title={absoluteTime(version.createdAt)}>
                    {relativeTime(version.createdAt)}
                  </time>
                  {index === 0 ? ' · latest' : ''}
                </span>
              </div>
              <details className={styles.versionDetails} open={index === 0}>
                <summary>Skill file</summary>
                <pre className={styles.fileBody}>{version.content}</pre>
              </details>
              {version.files.map((file) => (
                <details key={file.id} className={styles.versionDetails}>
                  <summary>
                    <FileText size={13} aria-hidden /> {file.fileName}
                  </summary>
                  <pre className={styles.fileBody}>{file.content}</pre>
                </details>
              ))}
            </li>
          ))}
        </ol>
        {canManage ? (
          <footer className={pageStyles.dialogFooter}>
            <button
              type="button"
              className={pageStyles.primaryButton}
              onClick={onEdit}
              data-testid="skill-library-edit"
            >
              <PenLine size={15} aria-hidden /> Edit as new version
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
};

// ── Tool allow-list (platform admin) ─────────────────────────────────────────

const ToolAllowList: React.FC<{ project: string }> = ({ project }) => {
  const tools = useProjectSkillTools(project);
  const setTools = useSetProjectSkillTools(project);
  const catalog = tools.data?.catalog ?? [];
  if (catalog.length === 0) return null;
  const allowed = tools.data?.allowed ?? [];
  return (
    <section className={styles.allowList} aria-labelledby="skill-tools-title" data-testid="skill-library-tool-allow-list">
      <h2 id="skill-tools-title" className={styles.allowTitle}>Tools {project} allows</h2>
      <p className={styles.toolsHint}>
        A skill in this project may name only these tools. Turning one off stops new skill versions
        from using it. Versions already saved keep it.
      </p>
      {catalog.map((tool) => (
        <label key={tool.id} className={styles.tool}>
          <input
            type="checkbox"
            checked={allowed.includes(tool.id)}
            disabled={setTools.isPending}
            onChange={(event) => {
              const rest = allowed.filter((id) => id !== tool.id);
              setTools.mutate(event.target.checked ? [...rest, tool.id] : rest);
            }}
            data-testid={`skill-library-allow-${tool.id}`}
          />
          <strong>{tool.label}</strong>
          <small>{tool.description}</small>
        </label>
      ))}
      {setTools.isError ? (
        <p className={pageStyles.formError} role="alert">{setTools.error.message}</p>
      ) : null}
    </section>
  );
};

// ── Connector write allow-list (platform admin) ──────────────────────────────

const ConnectorWriteAllowList: React.FC<{ project: string }> = ({ project }) => {
  const writes = useProjectConnectorWrites(project);
  const setWrites = useSetProjectConnectorWrites(project);
  const catalog = writes.data?.catalog ?? [];
  if (catalog.length === 0) return null;
  const allowed = writes.data?.allowed ?? [];
  return (
    <section
      className={styles.allowList}
      aria-labelledby="connector-writes-title"
      data-testid="skill-library-connector-write-allow-list"
    >
      <h2 id="connector-writes-title" className={styles.allowTitle}>Connector writes {project} allows</h2>
      <p className={styles.toolsHint}>
        A playbook in this project can publish and run only these connector actions that change
        something outside Apex. An approval gate must also come before each one. Turning one off
        stops published playbooks from running it.
      </p>
      {catalog.map((option) => (
        <label key={option.id} className={styles.tool}>
          <input
            type="checkbox"
            checked={allowed.includes(option.id)}
            disabled={setWrites.isPending}
            onChange={(event) => {
              const rest = allowed.filter((id) => id !== option.id);
              setWrites.mutate(event.target.checked ? [...rest, option.id] : rest);
            }}
            data-testid={`skill-library-allow-write-${option.id}`}
          />
          <strong>{option.integrationLabel} · {option.label}</strong>
          <small>{option.description}</small>
        </label>
      ))}
      {setWrites.isError ? (
        <p className={pageStyles.formError} role="alert">{setWrites.error.message}</p>
      ) : null}
    </section>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────

const SkillTile: React.FC<{ skill: ProjectSkillLibraryItem; onOpen: () => void }> = ({ skill, onOpen }) => {
  const latest = skill.versions[0];
  const interactive = latest?.skillType === 'interactive';
  const TypeIcon = interactive ? MessagesSquare : Bot;
  return (
    <li>
      <button
        type="button"
        className={`${pageStyles.card} ${styles.cardButton}`}
        onClick={onOpen}
        data-testid={`skill-library-card-${skill.id}`}
      >
        <div className={pageStyles.cardTop}>
          <span className={pageStyles.stateBadge} data-state={latest?.status ?? 'draft'}>
            {latest ? `v${latest.versionNumber}` : 'Draft'}
          </span>
          <span className={styles.typeTag} data-type={interactive ? 'interactive' : 'autonomous'}>
            <TypeIcon size={13} aria-hidden /> {interactive ? 'Interactive' : 'Autonomous'}
          </span>
        </div>
        <h2 className={pageStyles.cardTitle}>{skill.name}</h2>
        <p className={pageStyles.cardDescription}>{skill.description || 'No description yet.'}</p>
        <dl className={pageStyles.cardStats}>
          <div>
            <dt>Versions</dt>
            <dd>{skill.versions.length}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>{latest?.files.length ?? 0}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{latest ? relativeTime(latest.createdAt) : '—'}</dd>
          </div>
        </dl>
      </button>
    </li>
  );
};

function seedFromSkill(skill: ProjectSkillLibraryItem): SkillEditorSeed {
  const latest = skill.versions[0];
  return {
    title: skill.name,
    content: latest?.content ?? updateSkillFile(blankSkillFile(), { name: skill.name }),
    files: (latest?.files ?? []).map((file) => ({ path: file.fileName, content: file.content })),
  };
}

const ProjectSkillLibraryPage: React.FC<{ project: string }> = ({ project }) => {
  const { can, isSuperAdmin } = useAppShell();
  const canView = can('skills:view') || can('skills:manage');
  const canManage = can('skills:manage');
  const library = useProjectSkillLibrary(project);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [dialog, setDialog] = useState<{ seed: SkillEditorSeed; editing: boolean } | null>(null);
  const [openSkillId, setOpenSkillId] = useState<string | null>(null);

  const skills = useMemo(() => library.data?.skills ?? [], [library.data]);
  const visible = useMemo(
    () => filterProjectSkills(skills, search).filter((skill) => {
      if (filter === 'all') return true;
      const type = skill.versions[0]?.skillType === 'interactive' ? 'interactive' : 'autonomous';
      return type === filter;
    }),
    [skills, search, filter],
  );
  const openSkill = skills.find((skill) => skill.id === openSkillId) ?? null;
  const interactiveCount = skills.filter((skill) => skill.versions[0]?.skillType === 'interactive').length;
  const fileCount = skills.reduce((total, skill) => total + (skill.versions[0]?.files.length ?? 0), 0);

  const writeButton = canManage ? (
    <button
      type="button"
      className={pageStyles.primaryButton}
      onClick={() => setDialog({ seed: EMPTY_SEED, editing: false })}
      data-testid="skill-library-write"
    >
      <Plus size={15} aria-hidden /> Write a skill
    </button>
  ) : null;

  if (!canView) {
    return (
      <div className={pageStyles.page}>
        <div className={pageStyles.emptyState}>
          <p>You can view Playbooks, but not this project&apos;s skill library.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={pageStyles.page} data-testid="project-skill-library">
      <header className={pageStyles.hero}>
        <div className={pageStyles.heroText}>
          <h1 className={pageStyles.title}>Skill library</h1>
          <p className={pageStyles.subtitle}>
            Skills written for {project}. An agent step in any of this project&apos;s playbooks can
            use them. Base skills come with Apex and are picked in the builder.
          </p>
        </div>
        <div className={pageStyles.heroActions}>{writeButton}</div>
      </header>

      <dl className={`${pageStyles.pulse} ${styles.pulse}`} data-testid="skill-library-pulse">
        <div>
          <dt>Skills</dt>
          <dd>{skills.length}</dd>
          <span>in this project</span>
        </div>
        <div>
          <dt>Interactive</dt>
          <dd>{interactiveCount}</dd>
          <span>chat with a person</span>
        </div>
        <div>
          <dt>Reference files</dt>
          <dd>{fileCount}</dd>
          <span>on the latest versions</span>
        </div>
      </dl>

      {isSuperAdmin ? <ToolAllowList project={project} /> : null}
      {isSuperAdmin ? <ConnectorWriteAllowList project={project} /> : null}

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search skills"
        searchTestId="skill-library-search"
      >
        <DataGridFilterPills
          options={FILTER_OPTIONS}
          value={filter}
          onChange={setFilter}
          testIdPrefix="skill-library-filter"
          aria-label="Filter skills by type"
          data-testid="skill-library-filter"
        />
      </DataGridToolbar>

      {library.isPending ? (
        <ul className={pageStyles.grid} aria-busy="true" data-testid="skill-library-loading">
          {[0, 1, 2].map((index) => (
            <li key={index} className={`${pageStyles.cardSkeleton} ${styles.cardSkeleton}`} />
          ))}
        </ul>
      ) : library.isError ? (
        <div className={pageStyles.emptyState} role="status" data-testid="skill-library-error">
          <p>Could not load the skill library. {library.error.message}</p>
          <button
            type="button"
            className={pageStyles.secondaryButton}
            onClick={() => void library.refetch()}
            data-testid="skill-library-retry"
          >
            Try again
          </button>
        </div>
      ) : skills.length === 0 ? (
        <div className={pageStyles.emptyState} data-testid="skill-library-empty">
          <span className={pageStyles.emptyIcon} aria-hidden>
            <BookOpen size={22} />
          </span>
          <h2 className={pageStyles.emptyTitle}>No skills yet</h2>
          <p>
            A skill tells an agent step what to do and how to report back. Write one yourself or
            describe it and let AI draft it.
          </p>
          {writeButton}
        </div>
      ) : visible.length === 0 ? (
        <div className={pageStyles.emptyState} data-testid="skill-library-no-matches">
          <p>No skills match your search.</p>
        </div>
      ) : (
        <ul className={pageStyles.grid} data-testid="skill-library-grid">
          {visible.map((skill) => (
            <SkillTile key={skill.id} skill={skill} onOpen={() => setOpenSkillId(skill.id)} />
          ))}
        </ul>
      )}

      {openSkill ? (
        <SkillVersions
          skill={openSkill}
          canManage={canManage}
          onClose={() => setOpenSkillId(null)}
          onEdit={() => {
            setDialog({ seed: seedFromSkill(openSkill), editing: true });
            setOpenSkillId(null);
          }}
        />
      ) : null}

      {dialog ? (
        <SkillEditor
          project={project}
          seed={dialog.seed}
          editing={dialog.editing}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
};

export default ProjectSkillLibraryPage;
