import React, { useEffect, useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import type { BuildBriefAnalysisResponse } from '../../shared/types/build';
import type { InterviewBriefRecord, InterviewBriefSections } from '../../shared/types/interview';
import {
  useApproveBuildBrief,
  useBuildBriefAnalysis,
  useBuildBriefRecord,
  useDraftBuildBrief,
  useSaveBuildBrief,
} from '../hooks/useBuildBrief';
import { BuildBriefTakeoverNotice } from './BuildBriefTakeoverNotice';
import { BuildClassificationSummary } from './BuildClassificationSummary';
import { BuildRequirementList } from './BuildRequirementList';
import { BuildRequirementRows, type RequirementRowValue } from './BuildRequirementRows';
import { BuildRiskDecisions } from './BuildRiskDecisions';
import styles from './BuildBriefReview.module.css';

const DRAFT_FAILED_MESSAGE = 'The brief could not be drafted. Try again, or keep chatting and draft it later.';

type TextSectionKey = 'problemAndOutcome' | 'users' | 'scope' | 'scenarios' | 'assumptions';

interface BuildBriefFormValues extends Record<TextSectionKey, string> {
  unresolvedItems: string;
  requirements: RequirementRowValue[];
}

const TEXT_FIELDS: Array<{ key: TextSectionKey; label: string }> = [
  { key: 'problemAndOutcome', label: 'Problem and outcome' },
  { key: 'users', label: 'Users' },
  { key: 'scope', label: 'Scope' },
  { key: 'scenarios', label: 'Main scenarios' },
  { key: 'assumptions', label: 'Assumptions' },
];

const EMPTY_VALUES: BuildBriefFormValues = {
  problemAndOutcome: '',
  users: '',
  scope: '',
  scenarios: '',
  assumptions: '',
  unresolvedItems: '',
  requirements: [],
};

function toFormValues(
  brief: InterviewBriefRecord,
  analysis: BuildBriefAnalysisResponse | null,
): BuildBriefFormValues {
  return {
    problemAndOutcome: brief.sections.problemAndOutcome,
    users: brief.sections.users,
    scope: brief.sections.scope,
    scenarios: brief.sections.scenarios,
    assumptions: brief.sections.assumptions,
    unresolvedItems: brief.sections.unresolvedItems.join('\n'),
    requirements: (analysis?.requirements ?? [])
      .filter((row) => !row.retired)
      .map((row) => ({ requirementId: row.id, kind: row.kind, text: row.text })),
  };
}

function toSections(values: BuildBriefFormValues, brief: InterviewBriefRecord): InterviewBriefSections {
  return {
    ...brief.sections,
    problemAndOutcome: values.problemAndOutcome,
    users: values.users,
    scope: values.scope,
    scenarios: values.scenarios,
    assumptions: values.assumptions,
    unresolvedItems: values.unresolvedItems.split('\n').map((item) => item.trim()).filter(Boolean),
  };
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

interface BuildBriefReviewProps {
  interviewId: string;
}

export const BuildBriefReview: React.FC<BuildBriefReviewProps> = ({ interviewId }) => {
  const briefQuery = useBuildBriefRecord(interviewId);
  const analysisQuery = useBuildBriefAnalysis(interviewId);
  const save = useSaveBuildBrief(interviewId);
  const draft = useDraftBuildBrief(interviewId);
  const approve = useApproveBuildBrief(interviewId);
  const [alreadyApproved, setAlreadyApproved] = useState(false);

  const form = useForm<BuildBriefFormValues>({ defaultValues: EMPTY_VALUES });
  const { register, handleSubmit, reset, formState: { isDirty } } = form;

  const brief = briefQuery.data ?? null;
  const analysisState = analysisQuery.data;
  const analysis = analysisState?.kind === 'ready' ? analysisState.analysis : null;

  useEffect(() => {
    reset(brief ? toFormValues(brief, analysis) : EMPTY_VALUES);
  }, [brief, analysis, reset]);

  if (briefQuery.isLoading) return <div className={styles.state}>Loading brief…</div>;

  const draftFailed = analysisState?.kind === 'missing' && analysisState.draftFailed;
  const approved = brief?.status === 'approved' || analysis?.briefStatus === 'approved';
  const mayEdit = analysis?.viewer.mayEdit ?? false;
  const editable = Boolean(brief && analysis && mayEdit && !approved);
  const actingFor = analysis?.viewer.actingFor ?? null;
  const busy = save.isPending || draft.isPending || approve.isPending;
  const approveLabel = actingFor ? `Approve brief for ${actingFor}` : 'Approve brief';

  const mutationError = draft.error ?? save.error ?? approve.error;
  const panelError = mutationError?.message ?? (draftFailed && !brief ? DRAFT_FAILED_MESSAGE : null);

  const submit = handleSubmit(async (values) => {
    if (!brief) return;
    await save.mutateAsync({
      sections: toSections(values, brief),
      requirements: values.requirements.map((row) => ({ id: row.requirementId, kind: row.kind, text: row.text.trim() })),
    });
    reset(values);
  });

  const runDraft = () => {
    approve.reset();
    save.reset();
    draft.mutate();
  };

  const runApprove = () => {
    draft.reset();
    save.reset();
    approve.mutate(undefined, {
      onSuccess: (result) => setAlreadyApproved(result.alreadyApproved),
    });
  };

  const statusMessage = draft.isPending ? 'Drafting the brief…' : approve.isPending ? 'Approving the brief…' : '';

  return (
    <section
      className={styles.panel}
      aria-labelledby="build-brief-heading"
      {...{ 'data-testid': 'build-brief-review' }}
    >
      <div className={styles.header}>
        <div>
          <h2 id="build-brief-heading">Review build brief</h2>
          <p>Check what will be built, then approve it to start planning.</p>
        </div>
        {brief && <span className={styles.status}>{approved ? 'Approved' : `Draft v${brief.version}`}</span>}
      </div>

      <div className={styles.live} aria-live="polite">{statusMessage}</div>

      {panelError && (
        <div className={styles.error} role="alert" {...{ 'data-testid': 'build-brief-error' }}>
          {panelError}
        </div>
      )}

      {!brief && (
        <div className={styles.empty} {...{ 'data-testid': 'build-brief-empty' }}>
          <p>Your brief appears here when the agent has what it needs.</p>
          <button
            type="button"
            className={styles.primary}
            disabled={busy}
            onClick={runDraft}
            {...{ 'data-testid': 'build-brief-draft' }}
          >
            {draft.isPending ? 'Drafting…' : draftFailed ? 'Try drafting again' : 'Draft brief'}
          </button>
        </div>
      )}

      {brief && (
        <>
          {actingFor && editable && <BuildBriefTakeoverNotice requesterName={actingFor} />}
          {approved && (
            <p className={styles.note} role="status" {...{ 'data-testid': 'build-brief-approved-note' }}>
              {alreadyApproved
                ? 'This brief was already approved. Nothing changed.'
                : analysis?.approval
                  ? `Approved by ${analysis.approval.approvedBy.displayName} on ${formatDate(analysis.approval.approvedAt)}.`
                  : 'Approved.'}
            </p>
          )}
          {!approved && analysis && !mayEdit && (
            <p className={styles.note} {...{ 'data-testid': 'build-brief-readonly-note' }}>
              You can read this brief. Only the requester or an admin can change or approve it.
            </p>
          )}

          <FormProvider {...form}>
            <form
              className={styles.form}
              onSubmit={(event) => void submit(event)}
              {...{ 'data-testid': 'build-brief-form' }}
            >
              {TEXT_FIELDS.map((field) => (
                <label key={field.key} className={styles.field}>
                  <span>{field.label}</span>
                  <textarea
                    rows={3}
                    disabled={!editable}
                    {...register(field.key)}
                    {...{ 'data-testid': `build-brief-${field.key}` }}
                  />
                </label>
              ))}
              <label className={styles.field}>
                <span>Unresolved items</span>
                <small>Enter one item per line. Approval is allowed with unresolved items.</small>
                <textarea
                  rows={3}
                  disabled={!editable}
                  {...register('unresolvedItems')}
                  {...{ 'data-testid': 'build-brief-unresolvedItems' }}
                />
              </label>

              <div className={styles.wide}>
                {editable ? (
                  <BuildRequirementRows disabled={busy} />
                ) : (
                  analysis && <BuildRequirementList requirements={analysis.requirements} />
                )}
              </div>

              <div className={styles.wide}>
                {analysis && <BuildClassificationSummary classification={analysis.classification} />}
              </div>

              <div className={styles.wide}>
                <BuildRiskDecisions
                  decisions={analysis?.riskDecisions}
                  isLoading={analysisQuery.isLoading}
                  isError={analysisQuery.isError}
                  onRetry={() => void analysisQuery.refetch()}
                />
              </div>

              {editable && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy || isDirty}
                    title={isDirty ? 'Save or discard changes before drafting again' : undefined}
                    onClick={runDraft}
                    {...{ 'data-testid': 'build-brief-draft' }}
                  >
                    {draft.isPending ? 'Drafting…' : 'Redraft from conversation'}
                  </button>
                  <button
                    type="submit"
                    className={styles.secondary}
                    disabled={busy || !isDirty}
                    {...{ 'data-testid': 'build-brief-save' }}
                  >
                    {save.isPending ? 'Saving…' : 'Save draft'}
                  </button>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy || isDirty}
                    aria-label={approveLabel}
                    title={isDirty ? 'Save changes before approving' : undefined}
                    onClick={runApprove}
                    {...{ 'data-testid': 'build-brief-approve' }}
                  >
                    {approve.isPending ? 'Approving…' : approveLabel}
                  </button>
                </div>
              )}
            </form>
          </FormProvider>
        </>
      )}
    </section>
  );
};
