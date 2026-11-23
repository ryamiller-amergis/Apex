/**
 * The template gallery: Playbooks that ship with Apex and Playbooks a platform admin shared.
 * Using a template creates an unpublished copy in this project. A shared template installs as
 * many times as wanted; a shipped one installs once.
 */
import React, { useMemo, useState } from 'react';
import { ArrowRight, Layers, LayoutTemplate, Loader2, Trash2, Users, X } from 'lucide-react';
import type { PlaybookTemplateSummary } from '../../shared/types/playbookTemplates';
import { useAppShell } from '../hooks/useAppShell';
import {
  useInstallPlaybookTemplate,
  usePlaybookTemplates,
  useRemoveSharedPlaybookTemplate,
} from '../hooks/usePlaybookTemplates';
import { stepMeta } from './playbookStepCatalog';
import { relativeTime } from './playbookStatusFormat';
import styles from './PlaybookTemplateGallery.module.css';

interface PlaybookTemplateGalleryProps {
  project: string;
  canAuthor: boolean;
  onInstalled: (definitionId: string) => void;
  onClose: () => void;
}

const MAX_STEP_GLYPHS = 6;

function stateLabel(state: PlaybookTemplateSummary['installState']): string | null {
  if (state === 'draft-only') return 'Draft in this project';
  if (state === 'published') return 'Published in this project';
  if (state === 'update-available') return 'Update available';
  return null;
}

function actionLabel(template: PlaybookTemplateSummary, busy: boolean): string {
  if (busy) return 'Creating…';
  return template.installState === 'draft-only' ? 'Open draft' : 'Use template';
}

const StepFlow: React.FC<{ steps: string[] }> = ({ steps }) => {
  if (steps.length === 0) return <p className={styles.flowEmpty}>No steps</p>;
  const shown = steps.slice(0, MAX_STEP_GLYPHS);
  const hidden = steps.length - shown.length;
  return (
    <ol className={styles.flow} aria-label={`${steps.length} steps`}>
      {shown.map((stepType, index) => {
        const meta = stepMeta(stepType);
        const Icon = meta.icon;
        return (
          <li
            key={`${stepType}-${index}`}
            className={styles.flowGlyph}
            data-group={meta.group}
            title={meta.title}
          >
            <Icon size={14} aria-hidden />
            <span className={styles.srOnly}>{meta.title}</span>
          </li>
        );
      })}
      {hidden > 0 ? <li className={styles.flowMore}>+{hidden}</li> : null}
    </ol>
  );
};

interface CardProps {
  template: PlaybookTemplateSummary;
  canAuthor: boolean;
  canRemove: boolean;
  installing: boolean;
  removing: boolean;
  confirmingRemove: boolean;
  onUse: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}

const TemplateCard: React.FC<CardProps> = ({
  template,
  canAuthor,
  canRemove,
  installing,
  removing,
  confirmingRemove,
  onUse,
  onAskRemove,
  onCancelRemove,
  onRemove,
}) => {
  const shared = template.source === 'shared';
  const state = stateLabel(template.installState);
  const canUse = canAuthor && (template.installState === 'not-installed' || template.installState === 'draft-only');
  return (
    <li
      className={styles.card}
      data-source={shared ? 'shared' : 'shipped'}
      data-testid={`playbook-template-${template.templateKey}`}
    >
      <div className={styles.cardTop}>
        <span className={styles.category}>{shared ? 'Shared' : template.category}</span>
        {state ? (
          <span
            className={styles.stateBadge}
            data-state={template.installState}
            data-testid={`playbook-template-state-${template.templateKey}`}
          >
            {state}
          </span>
        ) : null}
      </div>

      <h3 className={styles.name}>{template.displayName}</h3>
      <p className={styles.summary}>{template.summary || 'No description.'}</p>

      <StepFlow steps={template.stepSummary} />

      <ul className={styles.facts}>
        {template.estimatedCostBand ? (
          <li className={styles.fact}>{template.estimatedCostBand} cost</li>
        ) : null}
        {template.requiredFlags.length > 0 ? (
          <li className={styles.fact} title={template.requiredFlags.join(', ')}>
            Needs {template.requiredFlags.length === 1 ? 'a feature flag' : `${template.requiredFlags.length} feature flags`}
          </li>
        ) : null}
        {shared && template.sourceProject ? (
          <li className={styles.fact}>
            <Users size={12} aria-hidden /> from {template.sourceProject}
          </li>
        ) : null}
      </ul>

      {shared && template.sharedAt ? (
        <p className={styles.sharedBy}>
          Shared {relativeTime(template.sharedAt)}
          {template.sharedByName ? ` by ${template.sharedByName}` : ''}
        </p>
      ) : null}

      {template.installState === 'update-available' ? (
        <p className={styles.note}>Open the Playbook editor to review and apply this update.</p>
      ) : null}

      <div className={styles.cardActions}>
        {canUse ? (
          <button
            type="button"
            className={styles.useButton}
            disabled={installing}
            data-testid={`playbook-template-install-${template.templateKey}`}
            onClick={onUse}
          >
            {installing ? <Loader2 size={14} className={styles.spin} aria-hidden /> : null}
            {actionLabel(template, installing)}
            {installing ? null : <ArrowRight size={14} aria-hidden />}
          </button>
        ) : null}
        {canRemove && !confirmingRemove ? (
          <button
            type="button"
            className={styles.removeButton}
            onClick={onAskRemove}
            data-testid={`playbook-template-remove-${template.templateKey}`}
          >
            <Trash2 size={14} aria-hidden /> Remove
          </button>
        ) : null}
      </div>

      {canRemove && confirmingRemove ? (
        <div className={styles.confirm} role="status">
          <p>Remove this template? Playbooks already created from it stay.</p>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={styles.dangerButton}
              disabled={removing}
              onClick={onRemove}
              data-testid={`playbook-template-remove-confirm-${template.templateKey}`}
            >
              {removing ? 'Removing…' : 'Remove template'}
            </button>
            <button
              type="button"
              className={styles.quietButton}
              disabled={removing}
              onClick={onCancelRemove}
              data-testid={`playbook-template-remove-cancel-${template.templateKey}`}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
};

export const PlaybookTemplateGallery: React.FC<PlaybookTemplateGalleryProps> = ({
  project,
  canAuthor,
  onInstalled,
  onClose,
}) => {
  const { isSuperAdmin } = useAppShell();
  const templates = usePlaybookTemplates(project, true);
  const install = useInstallPlaybookTemplate(project);
  const remove = useRemoveSharedPlaybookTemplate(project);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [removeKey, setRemoveKey] = useState<string | null>(null);

  const { shipped, shared } = useMemo(() => {
    const all = templates.data?.templates ?? [];
    return {
      shipped: all.filter((template) => template.source !== 'shared'),
      shared: all.filter((template) => template.source === 'shared'),
    };
  }, [templates.data]);

  const use = (templateKey: string) => {
    setInstallingKey(templateKey);
    install
      .mutateAsync(templateKey)
      .then((detail) => onInstalled(detail.definition.id))
      .catch(() => undefined)
      .finally(() => setInstallingKey(null));
  };

  const removeShared = (templateKey: string) => {
    remove
      .mutateAsync(templateKey)
      .then(() => setRemoveKey(null))
      .catch(() => undefined);
  };

  const renderCards = (list: PlaybookTemplateSummary[]) => (
    <ul className={styles.list}>
      {list.map((template) => (
        // data-testid-exempt — TemplateCard owns its playbook-template-<key> root id and button ids
        <TemplateCard
          key={template.templateKey}
          template={template}
          canAuthor={canAuthor}
          canRemove={isSuperAdmin && template.source === 'shared'}
          installing={install.isPending && installingKey === template.templateKey}
          removing={remove.isPending && removeKey === template.templateKey}
          confirmingRemove={removeKey === template.templateKey}
          onUse={() => use(template.templateKey)}
          onAskRemove={() => {
            remove.reset();
            setRemoveKey(template.templateKey);
          }}
          onCancelRemove={() => setRemoveKey(null)}
          onRemove={() => removeShared(template.templateKey)}
        />
      ))}
    </ul>
  );

  return (
    <section
      className={styles.gallery}
      aria-labelledby="playbook-template-gallery-title"
      data-testid="playbook-template-gallery"
    >
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h2 id="playbook-template-gallery-title" className={styles.title}>
            <LayoutTemplate size={18} aria-hidden /> Templates
          </h2>
          <p className={styles.subtitle}>
            Start from a working Playbook. You get your own copy to change, and it never changes
            when the template does.
          </p>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
          aria-label="Close templates"
          data-testid="playbook-template-gallery-close"
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      {templates.isPending ? <p className={styles.message}>Loading templates…</p> : null}
      {templates.isError ? <p role="alert" className={styles.error}>{templates.error.message}</p> : null}

      {shipped.length > 0 ? (
        <>
          <h3 className={styles.sectionTitle}>
            <Layers size={14} aria-hidden /> Built in
          </h3>
          {renderCards(shipped)}
        </>
      ) : null}

      {shared.length > 0 ? (
        <>
          <h3 className={styles.sectionTitle} data-testid="playbook-template-shared-heading">
            <Users size={14} aria-hidden /> Shared by platform admins
          </h3>
          {renderCards(shared)}
        </>
      ) : null}

      {install.isError ? <p role="alert" className={styles.error}>{install.error.message}</p> : null}
      {remove.isError ? <p role="alert" className={styles.error}>{remove.error.message}</p> : null}
    </section>
  );
};
