import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  computeRfpCostTotals,
  validateRfpDraftForPublish,
  type RfpCostLine,
  type RfpDecisionSummaryDraft,
  type RfpGeneratedDraft,
  type RfpProposalDraft,
  type RfpRequestDetail,
} from '../../shared/types/rfpIntake';
import {
  usePublishRfpProposal,
  useRegenerateRfpProposal,
  useRfpMentionCandidates,
  useSaveRfpProposalDraft,
} from '../hooks/useRfpTriage';
import { CostSource, CostTotalsRows } from './RfpProposalDocument';
import landing from './RfpIntakeLanding.module.css';
import styles from './RfpRequestWizard.module.css';

function toLines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function fromLines(items: string[]): string {
  return items.join('\n');
}

const amountText = z
  .string()
  .refine((value) => value.trim() === '' || (Number.isFinite(Number(value)) && Number(value) >= 0), 'Enter zero or more');

const costLineSchema = z
  .object({
    id: z.string(),
    low: amountText,
    expected: amountText,
    high: amountText,
    adminConfirmed: z.boolean(),
  })
  .superRefine((line, ctx) => {
    const filled = [line.low, line.expected, line.high].filter((value) => value.trim() !== '').length;
    if (filled > 0 && filled < 3) {
      ctx.addIssue({ code: 'custom', path: ['expected'], message: 'Enter low, expected, and high' });
      return;
    }
    if (filled === 3 && !(Number(line.low) <= Number(line.expected) && Number(line.expected) <= Number(line.high))) {
      ctx.addIssue({ code: 'custom', path: ['expected'], message: 'Low must not exceed expected, and expected must not exceed high' });
    }
  });

const proposalSchema = z.object({
  executiveSummary: z.string(),
  recommendedSolution: z.string(),
  scope: z.string(),
  timeline: z.string(),
  assumptions: z.string(),
  exclusions: z.string(),
  securityAndData: z.string(),
  ownership: z.string(),
  nextSteps: z.string(),
  costLines: z.array(costLineSchema),
  productOwnerId: z.string(),
});

type ProposalValues = z.infer<typeof proposalSchema>;
type CostLineValues = ProposalValues['costLines'][number];

const decisionSchema = z.object({
  summary: z.string().trim().min(1, 'Summary is required'),
  reasons: z.string(),
  alternatives: z.string(),
  nextSteps: z.string(),
});

type DecisionValues = z.infer<typeof decisionSchema>;

function amountString(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function mergeLine(line: RfpCostLine, values: CostLineValues | undefined): RfpCostLine {
  if (!values) return line;
  const priced = values.low.trim() !== '' && values.expected.trim() !== '' && values.high.trim() !== '';
  return {
    ...line,
    amounts: priced
      ? { low: Number(values.low), expected: Number(values.expected), high: Number(values.high) }
      : null,
    adminConfirmed: values.adminConfirmed,
  };
}

function buildProposalDraft(draft: RfpProposalDraft, values: ProposalValues): RfpProposalDraft {
  const byId = new Map(values.costLines.map((line) => [line.id, line]));
  const costLines = draft.costLines.map((line) => mergeLine(line, byId.get(line.id)));
  return {
    ...draft,
    sections: {
      ...draft.sections,
      executiveSummary: values.executiveSummary.trim(),
      recommendedSolution: values.recommendedSolution.trim(),
      scope: toLines(values.scope),
      timeline: values.timeline.trim(),
      assumptions: toLines(values.assumptions),
      exclusions: toLines(values.exclusions),
      securityAndData: values.securityAndData.trim(),
      ownership: values.ownership.trim(),
      nextSteps: toLines(values.nextSteps),
    },
    costLines,
    totals: computeRfpCostTotals(costLines),
  };
}

interface ActionsProps {
  detail: RfpRequestDetail;
  publishLabel: string;
  busy: boolean;
  errors: string[];
  onSave: () => void;
  onPublish: () => void;
}

const EditorActions: React.FC<ActionsProps> = ({ detail, publishLabel, busy, errors, onSave, onPublish }) => {
  const regenerate = useRegenerateRfpProposal();
  return (
    <>
      {errors.length > 0 && (
        <div className={`${landing.banner} ${landing.errorBanner}`} role="alert" {...{ 'data-testid': 'rfp-proposal-errors' }}>
          <ul className={styles.errorList}>
            {errors.map((error) => <li key={error}>{error}</li>)}
          </ul>
        </div>
      )}
      {regenerate.isError && <p className={landing.fieldError} role="alert">{regenerate.error.message}</p>}
      <div className={styles.actions}>
        <button
          type="button"
          className={landing.secondaryButton}
          disabled={busy || regenerate.isPending}
          onClick={() => regenerate.mutate({ id: detail.id })}
          {...{ 'data-testid': 'rfp-proposal-regenerate' }}
        >
          {regenerate.isPending ? 'Queueing…' : 'Regenerate draft'}
        </button>
        <button
          type="button"
          className={landing.secondaryButton}
          disabled={busy}
          onClick={onSave}
          {...{ 'data-testid': 'rfp-proposal-save' }}
        >
          Save draft
        </button>
        <button
          type="button"
          className={landing.primaryButton}
          disabled={busy}
          onClick={onPublish}
          {...{ 'data-testid': 'rfp-proposal-publish' }}
        >
          {busy ? 'Saving…' : publishLabel}
        </button>
      </div>
    </>
  );
};

function mutationErrors(...mutations: Array<{ isError: boolean; error: Error | null }>): string[] {
  return mutations.filter((mutation) => mutation.isError && mutation.error).map((mutation) => mutation.error!.message);
}

const ProposalDraftEditor: React.FC<{ detail: RfpRequestDetail; draft: RfpProposalDraft; onPublished: () => void }> = ({
  detail,
  draft,
  onPublished,
}) => {
  const save = useSaveRfpProposalDraft();
  const publish = usePublishRfpProposal();
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [ownerQuery, setOwnerQuery] = useState('');
  const [ownerName, setOwnerName] = useState(detail.proposal?.productOwnerName ?? '');
  const candidates = useRfpMentionCandidates(detail.id, ownerQuery.trim(), ownerQuery.trim().length > 0);
  const { sections } = draft;
  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProposalValues>({
    resolver: zodResolver(proposalSchema),
    defaultValues: {
      executiveSummary: sections.executiveSummary,
      recommendedSolution: sections.recommendedSolution,
      scope: fromLines(sections.scope),
      timeline: sections.timeline,
      assumptions: fromLines(sections.assumptions),
      exclusions: fromLines(sections.exclusions),
      securityAndData: sections.securityAndData,
      ownership: sections.ownership,
      nextSteps: fromLines(sections.nextSteps),
      costLines: draft.costLines.map((line) => ({
        id: line.id,
        low: amountString(line.amounts?.low),
        expected: amountString(line.amounts?.expected),
        high: amountString(line.amounts?.high),
        adminConfirmed: line.adminConfirmed,
      })),
      productOwnerId: detail.proposal?.productOwnerId ?? '',
    },
  });
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch() supplies live totals while the draft is edited; existing interaction stays as-is
  const liveTotals = buildProposalDraft(draft, watch()).totals;
  const busy = save.isPending || publish.isPending;

  const onSave = handleSubmit(async (values) => {
    setPublishErrors([]);
    await save.mutateAsync({ id: detail.id, draft: buildProposalDraft(draft, values) });
  });

  const onPublish = handleSubmit(async (values) => {
    const next = buildProposalDraft(draft, values);
    const problems = validateRfpDraftForPublish(next);
    if (!values.productOwnerId) problems.unshift('Choose a product owner');
    setPublishErrors(problems);
    if (problems.length > 0) return;
    await save.mutateAsync({ id: detail.id, draft: next });
    await publish.mutateAsync({ id: detail.id, productOwnerId: values.productOwnerId });
    onPublished();
  });

  const textArea = (name: keyof Omit<ProposalValues, 'costLines' | 'productOwnerId'>, label: string, hint?: string) => (
    <label className={landing.field}>
      <span className={landing.label}>{label}{hint ? ` (${hint})` : ''}</span>
      <textarea className={landing.textarea} {...register(name)} {...{ 'data-testid': `rfp-proposal-field-${name}` }} />
    </label>
  );

  return (
    <form
      className={landing.form}
      onSubmit={(event) => event.preventDefault()}
      {...{ 'data-testid': 'rfp-proposal-editor' }}
    >
      <h3 className={landing.blockTitle}>Review the generated proposal</h3>
      <p className={landing.subtitle}>
        Check every cost against its source, fill in anything marked unavailable, and confirm each line before publishing.
      </p>

      <table className={styles.costTable} {...{ 'data-testid': 'rfp-proposal-cost-table' }}>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Confirmed</th>
            <th scope="col">Low / expected / high (USD)</th>
          </tr>
        </thead>
        <tbody>
          {draft.costLines.map((line, index) => {
            const lineError = errors.costLines?.[index];
            const message = lineError?.expected?.message ?? lineError?.low?.message ?? lineError?.high?.message;
            return (
              <tr key={line.id} {...{ 'data-testid': `rfp-proposal-cost-${line.id}` }}>
                <td>
                  {line.label}
                  <span className={styles.sourceMeta}>
                    {line.quantity.toLocaleString()} {line.unit}{line.cadence === 'monthly' ? ' / month' : ' one-time'}
                  </span>
                  <CostSource line={line} />
                  {line.assumptions.length > 0 && <span className={styles.sourceMeta}>{line.assumptions.join(' ')}</span>}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Confirm ${line.label}`}
                    {...register(`costLines.${index}.adminConfirmed`)}
                    {...{ 'data-testid': `rfp-cost-confirm-${line.id}` }}
                  />
                </td>
                <td>
                  <div className={styles.amountInputs}>
                    {(['low', 'expected', 'high'] as const).map((key) => (
                      <input
                        key={key}
                        className={styles.amountInput}
                        inputMode="decimal"
                        aria-label={`${line.label} ${key}`}
                        placeholder={key}
                        {...register(`costLines.${index}.${key}`)}
                        {...{ 'data-testid': `rfp-cost-${line.id}-${key}` }}
                      />
                    ))}
                  </div>
                  {message && <span className={landing.fieldError}>{message}</span>}
                </td>
              </tr>
            );
          })}
          <CostTotalsRows totals={liveTotals} />
        </tbody>
      </table>

      {textArea('executiveSummary', 'Executive summary')}
      {textArea('recommendedSolution', 'Recommended solution')}
      {textArea('scope', 'Scope', 'one item per line')}
      {textArea('timeline', 'Timeline')}
      {textArea('assumptions', 'Assumptions', 'one per line')}
      {textArea('exclusions', 'Not included', 'one per line')}
      {textArea('securityAndData', 'Security and data')}
      {textArea('ownership', 'Ownership')}
      {textArea('nextSteps', 'Next steps', 'one per line')}

      <div className={landing.field}>
        <label className={landing.label} htmlFor="rfp-proposal-owner-search">Product owner</label>
        {ownerName && <p className={styles.ownerChosen}>Selected: {ownerName}</p>}
        <input
          id="rfp-proposal-owner-search"
          className={landing.input}
          placeholder="Search Apex users"
          value={ownerQuery}
          onChange={(event) => setOwnerQuery(event.target.value)}
          {...{ 'data-testid': 'rfp-proposal-owner-search' }}
        />
        {ownerQuery.trim() && (
          <ul
            className={styles.mentions}
            role="listbox"
            aria-label="Product owner suggestions"
            {...{ 'data-testid': 'rfp-proposal-owner-picker' }}
          >
            {(candidates.data ?? []).map((candidate) => (
              <li key={candidate.userId}>
                <button
                  type="button"
                  className={styles.mentionItem}
                  onClick={() => {
                    setValue('productOwnerId', candidate.userId);
                    setOwnerName(candidate.displayName);
                    setOwnerQuery('');
                  }}
                  {...{ 'data-testid': `rfp-proposal-owner-${candidate.userId}` }}
                >
                  {candidate.displayName} · {candidate.email}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <EditorActions
        detail={detail}
        publishLabel="Publish proposal"
        busy={busy}
        errors={[...publishErrors, ...mutationErrors(save, publish)]}
        onSave={() => void onSave().catch(() => undefined)}
        onPublish={() => void onPublish().catch(() => undefined)}
      />
    </form>
  );
};

const DecisionSummaryEditor: React.FC<{ detail: RfpRequestDetail; draft: RfpDecisionSummaryDraft; onPublished: () => void }> = ({
  detail,
  draft,
  onPublished,
}) => {
  const save = useSaveRfpProposalDraft();
  const publish = usePublishRfpProposal();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<DecisionValues>({
    resolver: zodResolver(decisionSchema),
    defaultValues: {
      summary: draft.summary,
      reasons: fromLines(draft.reasons),
      alternatives: fromLines(draft.alternatives),
      nextSteps: fromLines(draft.nextSteps),
    },
  });
  const busy = save.isPending || publish.isPending;
  const build = (values: DecisionValues): RfpDecisionSummaryDraft => ({
    ...draft,
    summary: values.summary.trim(),
    reasons: toLines(values.reasons),
    alternatives: toLines(values.alternatives),
    nextSteps: toLines(values.nextSteps),
  });

  const onSave = handleSubmit(async (values) => {
    await save.mutateAsync({ id: detail.id, draft: build(values) });
  });
  const onPublish = handleSubmit(async (values) => {
    await save.mutateAsync({ id: detail.id, draft: build(values) });
    await publish.mutateAsync({ id: detail.id });
    onPublished();
  });

  return (
    <form
      className={landing.form}
      onSubmit={(event) => event.preventDefault()}
      {...{ 'data-testid': 'rfp-decision-editor' }}
    >
      <h3 className={landing.blockTitle}>Review the decision summary</h3>
      <label className={landing.field}>
        <span className={landing.label}>Decision</span>
        <textarea className={landing.textarea} {...register('summary')} {...{ 'data-testid': 'rfp-decision-summary-input' }} />
        {errors.summary && <span className={landing.fieldError}>{errors.summary.message}</span>}
      </label>
      <label className={landing.field}>
        <span className={landing.label}>Why (one per line)</span>
        <textarea className={landing.textarea} {...register('reasons')} {...{ 'data-testid': 'rfp-decision-reasons-input' }} />
      </label>
      <label className={landing.field}>
        <span className={landing.label}>Alternatives (one per line)</span>
        <textarea className={landing.textarea} {...register('alternatives')} {...{ 'data-testid': 'rfp-decision-alternatives-input' }} />
      </label>
      <label className={landing.field}>
        <span className={landing.label}>Next steps (one per line)</span>
        <textarea className={landing.textarea} {...register('nextSteps')} {...{ 'data-testid': 'rfp-decision-next-steps-input' }} />
      </label>
      <EditorActions
        detail={detail}
        publishLabel="Publish decision summary"
        busy={busy}
        errors={mutationErrors(save, publish)}
        onSave={() => void onSave().catch(() => undefined)}
        onPublish={() => void onPublish().catch(() => undefined)}
      />
    </form>
  );
};

interface RfpProposalDraftEditorProps {
  detail: RfpRequestDetail;
  draft: RfpGeneratedDraft;
  onPublished: () => void;
}

export const RfpProposalDraftEditor: React.FC<RfpProposalDraftEditorProps> = ({ detail, draft, onPublished }) =>
  draft.kind === 'proposal'
    ? <ProposalDraftEditor detail={detail} draft={draft} onPublished={onPublished} />
    : <DecisionSummaryEditor detail={detail} draft={draft} onPublished={onPublished} />;
