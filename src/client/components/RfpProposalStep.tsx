import React, { useState } from 'react';
import {
  RFP_PROPOSAL_JOB_STATUS_LABELS,
  isRfpProposalJobActive,
  type RfpProposalGeneration,
  type RfpProposalJobStatus,
  type RfpRequestDetail,
} from '../../shared/types/rfpIntake';
import { useApproveRfpProposal, useRejectRfpProposal } from '../hooks/useRfpIntake';
import { useDeleteIntakeProject, useRegenerateRfpProposal } from '../hooks/useRfpTriage';
import { RfpProposalDocument } from './RfpProposalDocument';
import { RfpProposalDraftEditor } from './RfpProposalDraftEditor';
import landing from './RfpIntakeLanding.module.css';
import styles from './RfpRequestWizard.module.css';

function progressSteps(generation: RfpProposalGeneration): RfpProposalJobStatus[] {
  return generation.kind === 'proposal'
    ? ['queued', 'researching-prices', 'writing', 'ready']
    : ['queued', 'writing', 'ready'];
}

function stepLabel(status: RfpProposalJobStatus, generation: RfpProposalGeneration): string {
  if (status === 'writing' && generation.kind === 'decision-summary') return 'Writing decision summary';
  return RFP_PROPOSAL_JOB_STATUS_LABELS[status];
}

const GenerationProgress: React.FC<{ generation: RfpProposalGeneration }> = ({ generation }) => {
  const steps = progressSteps(generation);
  const current = steps.indexOf(generation.status);
  return (
    <section className={landing.block} role="status" aria-live="polite" {...{ 'data-testid': 'rfp-proposal-progress' }}>
      <h3 className={landing.blockTitle}>
        {generation.kind === 'proposal' ? 'Generating the proposal' : 'Generating the decision summary'}
      </h3>
      <p className={landing.subtitle}>
        {stepLabel(generation.status, generation)}. This page updates on its own; you can close it and come back.
        {generation.attempts > 1 && ` Attempt ${generation.attempts} of ${generation.maxAttempts}.`}
      </p>
      <ol className={styles.progressList}>
        {steps.map((status, index) => {
          const className = [
            styles.progressStep,
            index < current ? styles.progressStepDone : '',
            index === current ? styles.progressStepActive : '',
          ].filter(Boolean).join(' ');
          return (
            <li
              key={status}
              className={className}
              aria-current={index === current ? 'step' : undefined}
              {...{ 'data-testid': `rfp-proposal-progress-${status}` }}
            >
              {stepLabel(status, generation)}
            </li>
          );
        })}
      </ol>
    </section>
  );
};

const GenerationFailed: React.FC<{ detail: RfpRequestDetail; generation: RfpProposalGeneration }> = ({ detail, generation }) => {
  const regenerate = useRegenerateRfpProposal();
  return (
    <section className={`${landing.banner} ${landing.errorBanner}`} role="alert" {...{ 'data-testid': 'rfp-proposal-failed' }}>
      <p className={landing.blockTitle}>
        {generation.kind === 'proposal' ? 'The proposal could not be generated.' : 'The decision summary could not be generated.'}
      </p>
      {generation.errorMessage && <p>{generation.errorMessage}</p>}
      {regenerate.isError && <p className={landing.fieldError}>{regenerate.error.message}</p>}
      <div className={styles.actions}>
        <button
          type="button"
          className={landing.primaryButton}
          disabled={regenerate.isPending}
          onClick={() => regenerate.mutate({ id: detail.id })}
          {...{ 'data-testid': 'rfp-proposal-retry' }}
        >
          {regenerate.isPending ? 'Queueing…' : 'Try again'}
        </button>
      </div>
    </section>
  );
};

interface RfpProposalStepProps {
  detail: RfpRequestDetail;
  isRequester: boolean;
  canManage: boolean;
}

export const RfpProposalStep: React.FC<RfpProposalStepProps> = ({ detail, isRequester, canManage }) => {
  const approve = useApproveRfpProposal();
  const reject = useRejectRfpProposal();
  const deleteProject = useDeleteIntakeProject();
  const [rejecting, setRejecting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reason, setReason] = useState('');
  const [editingPublished, setEditingPublished] = useState(false);
  const proposal = detail.proposal ?? null;
  const approval = detail.approval ?? null;
  const generation = detail.proposalGeneration ?? null;
  const draft = detail.proposalDraft ?? null;
  const canEdit = canManage && !approval;

  if (canEdit) {
    if (generation && isRfpProposalJobActive(generation.status)) {
      return <GenerationProgress generation={generation} />;
    }
    if (generation?.status === 'failed') {
      return <GenerationFailed detail={detail} generation={generation} />;
    }
    if (generation?.status === 'ready' && draft) {
      const publishedCurrent = proposal?.document.jobId === draft.jobId;
      if (!publishedCurrent || editingPublished) {
        return (
          // data-testid-exempt — editor roots are marked inside RfpProposalDraftEditor
          <RfpProposalDraftEditor
            key={draft.editedAt ?? draft.generatedAt}
            detail={detail}
            draft={draft}
            onPublished={() => setEditingPublished(false)}
          />
        );
      }
    }
    if (!proposal) {
      return (
        <p className={landing.subtitle} {...{ 'data-testid': 'rfp-proposal-needs-review' }}>
          Submit the review on the Review step to generate the proposal.
        </p>
      );
    }
  }

  if (!proposal) {
    return (
      <p className={landing.subtitle} {...{ 'data-testid': 'rfp-proposal-pending' }}>
        Apex has not published a proposal yet. You will get a notification when it is ready.
      </p>
    );
  }

  const isProposal = proposal.document.kind === 'proposal';
  return (
    <>
      {approval && (
        <div className={styles.approved} {...{ 'data-testid': 'rfp-proposal-approved' }}>
          <p className={landing.blockTitle}>
            {detail.status === 'archived'
              ? `Archived. ${approval.apexProject} is hidden from project selection.`
              : `Approved. Your Apex project is ${approval.apexProject}.`}
          </p>
          <a href={approval.repoUrl} target="_blank" rel="noreferrer" {...{ 'data-testid': 'rfp-proposal-repo-link' }}>
            Open the {approval.repoName} repository
          </a>
          {canManage && detail.status !== 'archived' && (
            <div className={styles.rejectForm}>
              {deleteProject.isError && (
                <p className={`${landing.banner} ${landing.errorBanner}`} role="alert">{deleteProject.error.message}</p>
              )}
              {!confirmDelete ? (
                <button
                  type="button"
                  className={landing.secondaryButton}
                  disabled={deleteProject.isPending}
                  onClick={() => setConfirmDelete(true)}
                  {...{ 'data-testid': 'rfp-project-delete' }}
                >
                  Archive project
                </button>
              ) : (
                <>
                  <p className={landing.subtitle}>
                    Archive {approval.apexProject}. It will disappear from project selection. This request stays in Product Requests with status Archived.
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={landing.primaryButton}
                      disabled={deleteProject.isPending}
                      onClick={() => deleteProject.mutate({ id: detail.id })}
                      {...{ 'data-testid': 'rfp-project-delete-confirm' }}
                    >
                      {deleteProject.isPending ? 'Archiving…' : 'Confirm archive'}
                    </button>
                    <button
                      type="button"
                      className={landing.secondaryButton}
                      onClick={() => setConfirmDelete(false)}
                      {...{ 'data-testid': 'rfp-project-delete-cancel' }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {canEdit && (
        <p className={styles.publishedBanner} {...{ 'data-testid': 'rfp-proposal-published' }}>
          Published {new Date(proposal.publishedAt).toLocaleString()}. The requester can see this version.
        </p>
      )}
      {proposal.rejection && (
        <div className={styles.rejected} {...{ 'data-testid': 'rfp-proposal-rejected' }}>
          <p>
            {isRequester
              ? 'You rejected this proposal. Apex triage can revise it and publish again.'
              : 'The requester rejected this proposal.'}
          </p>
          <p>{proposal.rejection.reason}</p>
        </div>
      )}
      <RfpProposalDocument document={proposal.document} productOwnerName={proposal.productOwnerName} />
      {canEdit && generation?.status === 'ready' && draft && (
        <div className={styles.actions}>
          <button
            type="button"
            className={landing.secondaryButton}
            onClick={() => setEditingPublished(true)}
            {...{ 'data-testid': 'rfp-proposal-edit' }}
          >
            Edit and republish
          </button>
        </div>
      )}
      {isRequester && isProposal && !approval && !proposal.rejection && (
        <>
          {(approve.isError || reject.isError) && (
            <p className={`${landing.banner} ${landing.errorBanner}`} role="alert">
              {(approve.error ?? reject.error)?.message}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={landing.primaryButton}
              disabled={approve.isPending || reject.isPending}
              onClick={() => approve.mutate({ id: detail.id })}
              {...{ 'data-testid': 'rfp-proposal-approve' }}
            >
              {approve.isPending ? 'Creating repository…' : 'Approve proposal'}
            </button>
            <button
              type="button"
              className={landing.secondaryButton}
              disabled={approve.isPending || reject.isPending || rejecting}
              onClick={() => setRejecting(true)}
              {...{ 'data-testid': 'rfp-proposal-reject' }}
            >
              Reject proposal
            </button>
          </div>
          {rejecting && (
            <form
              className={styles.rejectForm}
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = reason.trim();
                if (!trimmed) return;
                reject.mutate({ id: detail.id, reason: trimmed });
              }}
              {...{ 'data-testid': 'rfp-proposal-reject-form' }}
            >
              <label className={landing.label} htmlFor="rfp-proposal-reject-reason">
                Tell Apex what should change
              </label>
              <textarea
                id="rfp-proposal-reject-reason"
                className={landing.textarea}
                value={reason}
                maxLength={2000}
                rows={3}
                onChange={(event) => setReason(event.target.value)}
                {...{ 'data-testid': 'rfp-proposal-reject-reason' }}
              />
              <div className={styles.actions}>
                <button
                  type="submit"
                  className={landing.primaryButton}
                  disabled={reject.isPending || reason.trim().length === 0}
                  {...{ 'data-testid': 'rfp-proposal-reject-submit' }}
                >
                  {reject.isPending ? 'Sending…' : 'Send rejection'}
                </button>
                <button
                  type="button"
                  className={landing.secondaryButton}
                  onClick={() => { setRejecting(false); setReason(''); }}
                  {...{ 'data-testid': 'rfp-proposal-reject-cancel' }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </>
  );
};
