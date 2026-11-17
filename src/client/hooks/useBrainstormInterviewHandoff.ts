import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BrainstormSessionDetail } from '../../shared/types/brainstorm';
import type {
  BrainstormArtifactDto,
  BrainstormArtifactType,
  BrainstormHandoffResultDto,
} from '../../shared/types/brainstormArtifact';
import { apiFetch, retryUnlessClientError } from './useBrainstormSessions';
import { brainstormArtifactKeys, sessionApiPath } from './useBrainstormArtifact';

export interface BrainstormInterviewSource {
  sessionId: string;
  sessionTitle: string | null;
  artifactType: BrainstormArtifactType | null;
  markdown: string;
  version: number;
}

/** The Brainstorm session and artifact the new interview page prefills from. */
export function useBrainstormInterviewSource(project: string, sessionId: string | null) {
  return useQuery({
    queryKey: ['brainstorm', project, 'interview-source', sessionId],
    enabled: Boolean(project && sessionId),
    queryFn: async (): Promise<BrainstormInterviewSource> => {
      const id = sessionId as string;
      const [sessionBody, artifactBody] = await Promise.all([
        apiFetch<{ session: BrainstormSessionDetail }>(sessionApiPath(project, id, '')),
        apiFetch<{ artifact: BrainstormArtifactDto }>(sessionApiPath(project, id, '/artifact')),
      ]);
      return {
        sessionId: id,
        sessionTitle: sessionBody.session.title,
        artifactType: artifactBody.artifact.type,
        markdown: artifactBody.artifact.markdown,
        version: artifactBody.artifact.version,
      };
    },
    retry: retryUnlessClientError,
    staleTime: Infinity,
  });
}

/** Records the interview the page created as the session's start-interview handoff. */
export function useRecordBrainstormInterview(project: string, sessionId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { interviewId: string }) => {
      if (!sessionId) throw new Error('No Brainstorm session to record the interview on.');
      return apiFetch<BrainstormHandoffResultDto>(sessionApiPath(project, sessionId, '/handoffs/interview'), {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    onSettled: () => {
      if (sessionId) void client.invalidateQueries({ queryKey: brainstormArtifactKeys.actions(project, sessionId) });
    },
  });
}
