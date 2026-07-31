/**
 * FEAT-006 — Host: Apex FAB Help seam → replay list → voluntary renderer + progress.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  UpdateWalkthroughProgressRequest,
  WalkthroughDefinition,
  WalkthroughProgress,
  WalkthroughProgressStatus,
  WalkthroughReplayEntry,
} from '../../shared/types/walkthrough';
import { toWalkthroughRendererDefinition } from '../utils/toWalkthroughRendererDefinition';
import {
  useUpdateWalkthroughProgress,
  useWalkthroughDefinition,
  useWalkthroughReplayList,
  WalkthroughApiError,
} from '../hooks/useWalkthroughReplay';
import { WalkthroughHelpPanel } from './WalkthroughHelpPanel';
import { WalkthroughProgressError } from './WalkthroughProgressError';
import { WalkthroughRenderer } from './WalkthroughRenderer';

export interface WalkthroughHelpHostProps {
  projectId: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function stepIndexFromProgress(
  definition: WalkthroughDefinition,
  lastStepId: string | null | undefined,
): number {
  if (!lastStepId) return 0;
  const idx = definition.steps.findIndex((s) => s.id === lastStepId);
  return idx >= 0 ? idx : 0;
}

export function initialStepIndexForReplay(
  definition: WalkthroughDefinition,
  progress: Pick<WalkthroughProgress, 'status' | 'lastStepId'> | null | undefined,
): number {
  if (progress?.status === 'completed') return 0;
  return stepIndexFromProgress(definition, progress?.lastStepId);
}

export const WalkthroughHelpHost: React.FC<WalkthroughHelpHostProps> = ({
  projectId,
  open,
  onOpenChange,
}) => {
  const listQuery = useWalkthroughReplayList(projectId, open);
  const progressMutation = useUpdateWalkthroughProgress(projectId);
  const previousProjectRef = useRef(projectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replayDefinition, setReplayDefinition] = useState<WalkthroughDefinition | null>(null);
  const [replaySessionId, setReplaySessionId] = useState('replay');
  const [initialStepIndex, setInitialStepIndex] = useState(0);
  const [staleDefinitionError, setStaleDefinitionError] = useState(false);
  const [progressError, setProgressError] = useState<{
    walkthroughId: string;
    body: UpdateWalkthroughProgressRequest;
  } | null>(null);

  const definitionQuery = useWalkthroughDefinition(
    projectId,
    selectedId,
    Boolean(selectedId),
  );

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset selection when panel closes
      setSelectedId(null);
      setStaleDefinitionError(false);
    }
  }, [open]);

  useEffect(() => {
    if (previousProjectRef.current === projectId) return;
    previousProjectRef.current = projectId;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale project-scoped replay state
    setSelectedId(null);
    setReplayDefinition(null);
    setStaleDefinitionError(false);
    setProgressError(null);
    onOpenChange(false);
  }, [projectId, onOpenChange]);

  useEffect(() => {
    if (!selectedId) return;
    if (definitionQuery.isError) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- definition refetch failed closed
      setStaleDefinitionError(true);
      setSelectedId(null);
      return;
    }
    if (!definitionQuery.data) return;

    const fromList = listQuery.data?.items.find((i) => i.walkthrough.id === selectedId);
    setInitialStepIndex(initialStepIndexForReplay(definitionQuery.data, fromList?.progress));
    setReplaySessionId(`replay-${selectedId}-${Date.now()}`);
    setReplayDefinition(definitionQuery.data);
    setSelectedId(null);
    setStaleDefinitionError(false);
    onOpenChange(false);
  }, [
    selectedId,
    definitionQuery.isError,
    definitionQuery.data,
    listQuery.data?.items,
    onOpenChange,
  ]);

  const handleSelect = useCallback((entry: WalkthroughReplayEntry) => {
    setStaleDefinitionError(false);
    setSelectedId(entry.walkthrough.id);
  }, []);

  const persistTerminal = useCallback(
    async (
      walkthroughId: string,
      status: Extract<WalkthroughProgressStatus, 'completed' | 'dismissed'>,
      revision: number,
      stepId: string,
    ) => {
      const body: UpdateWalkthroughProgressRequest = {
        status,
        revision,
        lastStepId: stepId,
      };
      try {
        await progressMutation.mutateAsync({ walkthroughId, body });
        setProgressError(null);
        setReplayDefinition(null);
      } catch {
        setProgressError({ walkthroughId, body });
      }
    },
    [progressMutation],
  );

  const persistSeenSafe = useCallback(
    (walkthroughId: string, revision: number, stepId: string) => {
      void progressMutation
        .mutateAsync({
          walkthroughId,
          body: { status: 'seen', revision, lastStepId: stepId },
        })
        .catch(() => {
          /* non-blocking for seen; terminal non-downgrade is server-enforced */
        });
    },
    [progressMutation],
  );

  const rendererDefinition = useMemo(
    () => (replayDefinition ? toWalkthroughRendererDefinition(replayDefinition) : null),
    [replayDefinition],
  );

  const panelError = listQuery.isError || staleDefinitionError;

  return (
    <>
      <WalkthroughHelpPanel
        open={open && !replayDefinition}
        loading={listQuery.isLoading || Boolean(selectedId && definitionQuery.isLoading)}
        error={panelError}
        items={staleDefinitionError ? [] : (listQuery.data?.items ?? [])}
        selectingId={selectedId}
        onClose={() => {
          setStaleDefinitionError(false);
          onOpenChange(false);
        }}
        onRetry={() => {
          setStaleDefinitionError(false);
          void listQuery.refetch();
        }}
        onSelect={handleSelect}
        {...{ 'data-testid': 'walkthrough-help-panel' }}
      />

      {rendererDefinition && (
        <div {...{ 'data-testid': 'walkthrough-replay-host' }}>
          <WalkthroughRenderer
            definition={rendererDefinition}
            open
            initialStepIndex={initialStepIndex}
            playbackSessionId={replaySessionId}
            onSeen={({ walkthroughId, revision, stepId }) => {
              persistSeenSafe(walkthroughId, revision, stepId);
            }}
            onStepChange={({ walkthroughId, revision, stepId }) => {
              persistSeenSafe(walkthroughId, revision, stepId);
            }}
            onComplete={({ walkthroughId, revision, stepId }) => {
              void persistTerminal(walkthroughId, 'completed', revision, stepId);
            }}
            onDismiss={({ walkthroughId, revision, stepId }) => {
              void persistTerminal(walkthroughId, 'dismissed', revision, stepId);
            }}
          />
        </div>
      )}

      <WalkthroughProgressError
        open={Boolean(progressError)}
        submitting={progressMutation.isPending}
        message={
          progressMutation.error instanceof WalkthroughApiError
            ? progressMutation.error.message
            : undefined
        }
        onRetry={() => {
          if (!progressError) return;
          void persistTerminal(
            progressError.walkthroughId,
            progressError.body.status as 'completed' | 'dismissed',
            progressError.body.revision,
            progressError.body.lastStepId ?? '',
          );
        }}
        onCloseWithoutAcknowledgement={() => {
          setProgressError(null);
          setReplayDefinition(null);
        }}
        allowCloseWithoutAcknowledgement={!replayDefinition?.isRequired}
      />
    </>
  );
};
