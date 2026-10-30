import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BrainstormSessionDetail } from '../../shared/types/brainstorm';
import {
  BRAINSTORM_ARTIFACT_POLL_MS,
  type BrainstormArtifactDto,
  type BrainstormArtifactType,
  type BrainstormCompareDto,
  type BrainstormTypeSwitchAcceptedDto,
  type BrainstormVersionListDto,
  type BrainstormVersionSummaryDto,
} from '../../shared/types/brainstormArtifact';
import { apiFetch, brainstormKeys, brainstormPath, retryUnlessClientError } from './useBrainstormSessions';

/** How often the creator's panel rereads the artifact while a collaborator turn may be writing it. */
const TURN_POLL_MS = 3_000;

export const brainstormArtifactKeys = {
  artifact: (project: string, sessionId: string) => ['brainstorm', project, 'artifact', sessionId] as const,
  versions: (project: string, sessionId: string) => ['brainstorm', project, 'artifact-versions', sessionId] as const,
  compare: (project: string, sessionId: string, from: number, to: number) =>
    ['brainstorm', project, 'artifact-compare', sessionId, from, to] as const,
  actions: (project: string, sessionId: string) => ['brainstorm', project, 'actions', sessionId] as const,
};

export function sessionApiPath(project: string, sessionId: string, suffix: string, query: Record<string, string | number> = {}): string {
  const base = brainstormPath(project, `/${encodeURIComponent(sessionId)}${suffix}`);
  const extra = Object.entries(query).map(([key, value]) => `&${key}=${encodeURIComponent(String(value))}`).join('');
  return `${base}${extra}`;
}

function invalidateArtifact(client: ReturnType<typeof useQueryClient>, project: string, sessionId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: brainstormArtifactKeys.artifact(project, sessionId) }),
    client.invalidateQueries({ queryKey: brainstormArtifactKeys.versions(project, sessionId) }),
    client.invalidateQueries({ queryKey: brainstormArtifactKeys.actions(project, sessionId) }),
  ]);
}

/**
 * The live artifact. The creator rereads it while a turn runs and once when it ends;
 * other members poll while the session is active.
 */
export function useBrainstormArtifact(project: string, session: BrainstormSessionDetail, turnRunning: boolean) {
  const client = useQueryClient();
  const wasRunning = useRef(turnRunning);

  useEffect(() => {
    if (wasRunning.current && !turnRunning) void invalidateArtifact(client, project, session.id);
    wasRunning.current = turnRunning;
  }, [client, project, session.id, turnRunning]);

  const pollMs = turnRunning
    ? TURN_POLL_MS
    : !session.canMutate && session.state === 'active'
      ? BRAINSTORM_ARTIFACT_POLL_MS
      : false;

  return useQuery({
    queryKey: brainstormArtifactKeys.artifact(project, session.id),
    enabled: Boolean(project && session.id),
    queryFn: async () => {
      const body = await apiFetch<{ artifact: BrainstormArtifactDto }>(sessionApiPath(project, session.id, '/artifact'));
      return body.artifact;
    },
    retry: retryUnlessClientError,
    refetchInterval: pollMs,
  });
}

export function useBrainstormVersions(project: string, sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: brainstormArtifactKeys.versions(project, sessionId),
    enabled: enabled && Boolean(project && sessionId),
    queryFn: () => apiFetch<BrainstormVersionListDto>(sessionApiPath(project, sessionId, '/artifact/versions', { limit: 200 })),
    retry: retryUnlessClientError,
  });
}

export function useBrainstormCompare(project: string, sessionId: string, pair: [number, number] | null) {
  return useQuery({
    queryKey: brainstormArtifactKeys.compare(project, sessionId, pair?.[0] ?? 0, pair?.[1] ?? 0),
    enabled: Boolean(pair && project && sessionId),
    queryFn: () => apiFetch<BrainstormCompareDto>(
      sessionApiPath(project, sessionId, '/artifact/compare', { from: pair![0], to: pair![1] }),
    ),
    retry: retryUnlessClientError,
  });
}

export function useLabelCheckpoint(project: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; expectedVersion: number }) =>
      apiFetch<{ version: BrainstormVersionSummaryDto }>(sessionApiPath(project, sessionId, '/artifact/checkpoints'), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSettled: () => invalidateArtifact(client, project, sessionId),
  });
}

export function useRollbackArtifact(project: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { toSequence: number; expectedVersion: number }) =>
      apiFetch<{ version: BrainstormVersionSummaryDto }>(sessionApiPath(project, sessionId, '/artifact/rollback'), {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSettled: () => invalidateArtifact(client, project, sessionId),
  });
}

export type TypeSwitchResult =
  | { kind: 'set'; version: BrainstormVersionSummaryDto }
  | { kind: 'reshaping'; accepted: BrainstormTypeSwitchAcceptedDto };

export function useSwitchArtifactType(project: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { type: BrainstormArtifactType; expectedVersion: number }): Promise<TypeSwitchResult> => {
      const body = await apiFetch<{ version?: BrainstormVersionSummaryDto } & Partial<BrainstormTypeSwitchAcceptedDto>>(
        sessionApiPath(project, sessionId, '/artifact/type'),
        { method: 'POST', body: JSON.stringify(input) },
      );
      return body.version
        ? { kind: 'set', version: body.version }
        : { kind: 'reshaping', accepted: body as BrainstormTypeSwitchAcceptedDto };
    },
    onSettled: () => Promise.all([
      invalidateArtifact(client, project, sessionId),
      client.invalidateQueries({ queryKey: brainstormKeys.messages(project, sessionId) }),
    ]),
  });
}
