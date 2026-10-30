import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BrainstormActionId,
  BrainstormActionsDto,
  BrainstormHandoffExecutingDto,
  BrainstormHandoffPreviewDto,
  BrainstormHandoffResultDto,
  BrainstormHandoffSummaryDto,
} from '../../shared/types/brainstormArtifact';
import { apiFetch, retryUnlessClientError } from './useBrainstormSessions';
import { brainstormArtifactKeys, sessionApiPath } from './useBrainstormArtifact';

const EXECUTING_POLL_MS = 2_000;
const EXECUTING_MAX_POLLS = 45;

/**
 * Next actions as the server computes them. The panel and the inline chips read
 * this one query, so they always list the same actions.
 */
export function useBrainstormActions(project: string, sessionId: string, enabled = true) {
  return useQuery({
    queryKey: brainstormArtifactKeys.actions(project, sessionId),
    enabled: enabled && Boolean(project && sessionId),
    queryFn: () => apiFetch<BrainstormActionsDto>(sessionApiPath(project, sessionId, '/actions')),
    retry: retryUnlessClientError,
  });
}

export function usePreviewHandoff(project: string, sessionId: string) {
  return useMutation({
    mutationFn: (input: { actionId: BrainstormActionId; expectedVersion: number }) =>
      apiFetch<BrainstormHandoffPreviewDto>(sessionApiPath(project, sessionId, '/handoffs/preview'), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Confirms once; while another request is creating the record, waits for it to finish. */
export function useConfirmHandoff(project: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (preview: Pick<BrainstormHandoffPreviewDto, 'handoffId' | 'idempotencyKey'>) => {
      const path = sessionApiPath(project, sessionId, `/handoffs/${encodeURIComponent(preview.handoffId)}/confirm`);
      let outcome = await apiFetch<BrainstormHandoffResultDto | BrainstormHandoffExecutingDto>(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': preview.idempotencyKey },
        body: JSON.stringify({ confirm: true }),
      });
      for (let poll = 0; outcome.state === 'executing' && poll < EXECUTING_MAX_POLLS; poll += 1) {
        await sleep(EXECUTING_POLL_MS);
        const summary = await apiFetch<BrainstormHandoffSummaryDto>(
          sessionApiPath(project, sessionId, `/handoffs/${encodeURIComponent(preview.handoffId)}`),
        );
        if (summary.state === 'completed' && summary.resultRef) {
          outcome = { handoffId: summary.handoffId, state: 'completed', resultRef: summary.resultRef, replayed: true };
        } else if (summary.state !== 'executing') {
          outcome = await apiFetch<BrainstormHandoffResultDto | BrainstormHandoffExecutingDto>(path, {
            method: 'POST',
            headers: { 'Idempotency-Key': preview.idempotencyKey },
            body: JSON.stringify({ confirm: true }),
          });
        }
      }
      if (outcome.state !== 'completed') throw new Error('The handoff is still being created. Check again shortly.');
      return outcome;
    },
    onSettled: () => client.invalidateQueries({ queryKey: brainstormArtifactKeys.actions(project, sessionId) }),
  });
}

export function useKeepStandalone(project: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { expectedVersion: number }) =>
      apiFetch<BrainstormHandoffResultDto>(sessionApiPath(project, sessionId, '/handoffs/keep-standalone'), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: brainstormArtifactKeys.actions(project, sessionId) }),
  });
}
