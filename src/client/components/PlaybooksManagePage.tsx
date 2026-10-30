/**
 * The Playbooks landing page: every playbook in the project as a card with its shape, recent run
 * outcomes and headline numbers. Opening a card goes to that playbook's dashboard.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ListChecks, Plus, Workflow, X } from 'lucide-react';
import type { PlaybookDefinitionSummary, PlaybookRunSummary } from '../../shared/types/playbook';
import { useAppShell } from '../hooks/useAppShell';
import { PlaybookTemplateGallery } from './PlaybookTemplateGallery';
import {
  useCreatePlaybookDefinition,
  usePlaybookDefinition,
  usePlaybookDefinitions,
} from '../hooks/usePlaybookDefinitions';
import { usePlaybookRuns } from '../hooks/usePlaybookRuns';
import { DataGridFilterPills, DataGridToolbar } from './DataGridToolbar';
import { orderedSteps, stepMeta } from './playbookStepCatalog';
import {
  computeRunStats,
  formatSuccessRate,
  groupRunsByDefinition,
  runTone,
} from './playbookRunStats';
import { absoluteTime, relativeTime, runStatusLabel } from './playbookStatusFormat';
import styles from './PlaybooksManagePage.module.css';

type StateFilter = 'all' | 'published' | 'draft';

const FILTER_OPTIONS = [
  { label: 'All', value: 'all' },
  { label: 'Published', value: 'published' },
  { label: 'Draft only', value: 'draft' },
] as const;

const RIBBON_SLOTS = 20;
const FLOW_GLYPH_LIMIT = 6;

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the playbook a name.'),
  description: z.string(),
});
type CreateFormValues = z.infer<typeof createSchema>;

// ── Card pieces ──────────────────────────────────────────────────────────────

const FlowGlyphs: React.FC<{ project: string; definitionId: string }> = ({ project, definitionId }) => {
  const detail = usePlaybookDefinition(project, definitionId);
  if (detail.isPending) return <div className={styles.flowSkeleton} aria-hidden />;
  const steps = detail.data ? orderedSteps(detail.data.draft.graph) : [];
  if (!steps.length) return <p className={styles.flowEmpty}>No steps yet</p>;
  const shown = steps.slice(0, FLOW_GLYPH_LIMIT);
  const hidden = steps.length - shown.length;
  return (
    <ol className={styles.flow} aria-label={`${steps.length} steps`}>
      {shown.map((node) => {
        const meta = stepMeta(node.stepType);
        const Icon = meta.icon;
        return (
          <li
            key={node.id}
            className={styles.flowGlyph}
            title={`${meta.title} · ${node.id}`}
            {...{ 'data-group': meta.group }}
          >
            <Icon size={13} aria-hidden />
          </li>
        );
      })}
      {hidden > 0 ? <li className={styles.flowMore}>+{hidden}</li> : null}
    </ol>
  );
};

const RunRibbon: React.FC<{ runs: readonly PlaybookRunSummary[] }> = ({ runs }) => {
  if (runs.length === 0) {
    return <p className={styles.ribbonEmpty}>No runs yet</p>;
  }
  const recent = runs.slice(0, RIBBON_SLOTS).reverse();
  const empty = RIBBON_SLOTS - recent.length;
  return (
    <div className={styles.ribbon} aria-label={`Last ${recent.length} runs`}>
      {Array.from({ length: empty }, (_, index) => (
        <span key={`empty-${index}`} className={styles.tick} aria-hidden />
      ))}
      {recent.map((run) => (
        <span
          key={run.runId}
          className={styles.tick}
          title={`${runStatusLabel(run.status)} · ${absoluteTime(run.startedAt)}`}
          {...{ 'data-tone': runTone(run.status) }}
        />
      ))}
    </div>
  );
};

const PlaybookCard: React.FC<{
  project: string;
  definition: PlaybookDefinitionSummary;
  runs: readonly PlaybookRunSummary[];
  'data-testid': string;
}> = ({ project, definition, runs, 'data-testid': testId }) => {
  const stats = computeRunStats(runs);
  const live = stats.running + stats.waiting;
  const published = definition.currentPublishedVersionNumber !== null;
  return (
    <li>
      <Link
        to={`/playbooks/${definition.id}`}
        className={styles.card}
        data-testid={testId}
      >
        <div className={styles.cardTop}>
          <span className={styles.stateBadge} {...{ 'data-state': published ? 'published' : 'draft' }}>
            {published ? `v${definition.currentPublishedVersionNumber}` : 'Draft'}
          </span>
          {live > 0 ? (
            <span className={styles.liveTag}>
              <span className={styles.liveDot} aria-hidden />
              {live} active
            </span>
          ) : null}
        </div>
        <h2 className={styles.cardTitle}>{definition.name}</h2>
        <p className={styles.cardDescription}>
          {definition.description?.trim() || 'No description yet.'}
        </p>
        <FlowGlyphs project={project} definitionId={definition.id} />
        <RunRibbon runs={runs} />
        <dl className={styles.cardStats}>
          <div>
            <dt>Runs</dt>
            <dd>{stats.total}</dd>
          </div>
          <div>
            <dt>Success</dt>
            <dd>{formatSuccessRate(stats.successRate)}</dd>
          </div>
          <div>
            <dt>Last run</dt>
            <dd>{stats.lastRunAt ? relativeTime(stats.lastRunAt) : 'Never'}</dd>
          </div>
        </dl>
      </Link>
    </li>
  );
};

// ── Create dialog ────────────────────────────────────────────────────────────

const CreatePlaybookDialog: React.FC<{
  project: string;
  onClose: () => void;
  onCreated: (definitionId: string) => void;
  'data-testid': string;
}> = ({ project, onClose, onCreated, 'data-testid': testId }) => {
  const create = useCreatePlaybookDefinition(project);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: '', description: '' },
  });
  const nameField = register('name');

  useEffect(() => {
    nameRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = handleSubmit(async (values) => {
    setError(null);
    try {
      const result = await create.mutateAsync({
        name: values.name.trim(),
        description: values.description.trim(),
        graph: { nodes: [], edges: [] },
      });
      onCreated(result.definition.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the playbook.');
    }
  });

  return (
    <div className={styles.overlay} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="playbook-create-title"
        onSubmit={(event) => void submit(event)}
        data-testid={testId}
      >
        <header className={styles.dialogHeader}>
          <h2 id="playbook-create-title" className={styles.dialogTitle}>New playbook</h2>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label="Close"
            {...{ 'data-testid': 'playbook-create-close' }}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <label className={styles.formField}>
          <span>Name</span>
          <input
            {...nameField}
            ref={(element) => {
              nameField.ref(element);
              nameRef.current = element;
            }}
            placeholder="e.g. Design doc review"
            {...{ 'data-testid': 'playbook-create-name' }}
          />
        </label>
        {errors.name ? <p className={styles.formError}>{errors.name.message}</p> : null}
        <label className={styles.formField}>
          <span>Description <em>optional</em></span>
          <textarea
            rows={3}
            {...register('description')}
            placeholder="What does this playbook do, and when should it run?"
            {...{ 'data-testid': 'playbook-create-description' }}
          />
        </label>
        {error ? <p className={styles.formError} role="alert">{error}</p> : null}
        <footer className={styles.dialogFooter}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onClose}
            {...{ 'data-testid': 'playbook-create-cancel' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={create.isPending}
            {...{ 'data-testid': 'playbook-create-submit' }}
          >
            {create.isPending ? 'Creating…' : 'Create and open'}
          </button>
        </footer>
      </form>
    </div>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────

interface PlaybooksManagePageProps {
  project: string;
}

export const PlaybooksManagePage: React.FC<PlaybooksManagePageProps> = ({ project }) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canAuthor = can('playbooks:author');
  const definitions = usePlaybookDefinitions(project);
  const runs = usePlaybookRuns(project);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  const [creating, setCreating] = useState(false);
  const [browsingTemplates, setBrowsingTemplates] = useState(false);

  const allRuns = useMemo(() => runs.data?.runs ?? [], [runs.data]);
  const runsByDefinition = useMemo(() => groupRunsByDefinition(allRuns), [allRuns]);
  const overall = useMemo(() => computeRunStats(allRuns), [allRuns]);
  const list = useMemo(() => definitions.data?.definitions ?? [], [definitions.data]);
  const publishedCount = list.filter((d) => d.currentPublishedVersionNumber !== null).length;

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return list.filter((definition) => {
      const published = definition.currentPublishedVersionNumber !== null;
      if (filter === 'published' && !published) return false;
      if (filter === 'draft' && published) return false;
      if (!query) return true;
      return `${definition.name} ${definition.description ?? ''}`.toLowerCase().includes(query);
    });
  }, [list, filter, search]);

  const newButton = canAuthor ? (
    <button
      type="button"
      className={styles.primaryButton}
      onClick={() => setCreating(true)}
      {...{ 'data-testid': 'playbook-create-open' }}
    >
      <Plus size={15} aria-hidden /> New blank Playbook
    </button>
  ) : null;

  return (
    <div className={styles.page} {...{ 'data-testid': 'playbooks-manage-page' }}>
      <header className={styles.hero}>
        <div className={styles.heroText}>
          <h1 className={styles.title}>Playbooks</h1>
          <p className={styles.subtitle}>
            Saved, versioned workflows Apex runs for {project}. Open one to see how it is doing, or
            to change what it does.
          </p>
        </div>
        <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setBrowsingTemplates(true)}
              data-testid="playbook-template-browse"
            >
              Browse templates
            </button>
          <Link
            to="/playbooks?view=runs"
            className={styles.secondaryButton}
            {...{ 'data-testid': 'playbooks-all-runs' }}
          >
            <ListChecks size={15} aria-hidden /> All runs
          </Link>
          {newButton}
        </div>
      </header>

      {browsingTemplates ? (
        <PlaybookTemplateGallery
          project={project}
          canAuthor={canAuthor}
          onClose={() => setBrowsingTemplates(false)}
          onInstalled={(definitionId) => navigate(`/playbooks/${definitionId}`)}
        />
      ) : null}

      <dl className={styles.pulse} {...{ 'data-testid': 'playbooks-pulse' }}>
        <div>
          <dt>Playbooks</dt>
          <dd>{list.length}</dd>
          <span>{publishedCount} published</span>
        </div>
        <div>
          <dt>Active now</dt>
          <dd>{overall.running + overall.waiting}</dd>
          <span>{overall.waiting} waiting on someone</span>
        </div>
        <div>
          <dt>Recent runs</dt>
          <dd>{overall.total}</dd>
          <span>
            {runs.data && runs.data.total > allRuns.length
              ? `latest ${allRuns.length} of ${runs.data.total}`
              : 'across all playbooks'}
          </span>
        </div>
        <div>
          <dt>Success rate</dt>
          <dd>{formatSuccessRate(overall.successRate)}</dd>
          <span>of finished runs</span>
        </div>
      </dl>

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search playbooks"
        searchTestId="playbooks-search"
      >
        <DataGridFilterPills
          options={FILTER_OPTIONS}
          value={filter}
          onChange={setFilter}
          testIdPrefix="playbooks-filter"
          aria-label="Filter playbooks"
          data-testid="playbooks-filter"
        />
      </DataGridToolbar>

      {definitions.isPending ? (
        <ul className={styles.grid} aria-busy="true" {...{ 'data-testid': 'playbooks-loading' }}>
          {[0, 1, 2].map((index) => (
            <li key={index} className={styles.cardSkeleton} />
          ))}
        </ul>
      ) : definitions.isError ? (
        <div className={styles.emptyState} role="status" {...{ 'data-testid': 'playbooks-error' }}>
          <p>Could not load playbooks. {definitions.error.message}</p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => void definitions.refetch()}
            {...{ 'data-testid': 'playbooks-retry' }}
          >
            Try again
          </button>
        </div>
      ) : list.length === 0 ? (
        <div className={styles.emptyState} {...{ 'data-testid': 'playbooks-empty' }}>
          <span className={styles.emptyIcon} aria-hidden>
            <Workflow size={22} />
          </span>
          <h2 className={styles.emptyTitle}>No playbooks yet</h2>
          <p>
            A playbook chains steps such as an agent task, an approval and a notification, then runs
            them the same way every time.
          </p>
          {newButton}
        </div>
      ) : visible.length === 0 ? (
        <div className={styles.emptyState} {...{ 'data-testid': 'playbooks-no-matches' }}>
          <p>No playbooks match your search.</p>
        </div>
      ) : (
        <ul className={styles.grid} {...{ 'data-testid': 'playbooks-grid' }}>
          {visible.map((definition) => (
            <PlaybookCard
              key={definition.id}
              project={project}
              definition={definition}
              runs={runsByDefinition.get(definition.id) ?? []}
              data-testid={`playbook-card-${definition.id}`}
            />
          ))}
        </ul>
      )}

      {creating ? (
        <CreatePlaybookDialog
          project={project}
          onClose={() => setCreating(false)}
          onCreated={(definitionId) =>
            navigate(`/playbooks/definitions/${definitionId}`)
          }
          data-testid="playbook-create-dialog"
        />
      ) : null}
    </div>
  );
};

export default PlaybooksManagePage;
