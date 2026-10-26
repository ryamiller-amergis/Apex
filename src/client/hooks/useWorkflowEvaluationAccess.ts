import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WORKFLOW_HUMAN_EVALUATION_FLAG } from '../../shared/types/featureFlags';
import {
  WORKFLOW_EVALUATION_SUBMIT,
  WORKFLOW_EVALUATION_VIEW,
} from '../../shared/types/workflowEvaluationAccess';
import { useAppShell } from './useAppShell';
import { useFeatureFlags } from './useFeatureFlags';

export interface WorkflowEvaluationAccess {
  flagEnabled: boolean;
  canView: boolean;
  canSubmit: boolean;
  canAdmin: boolean;
  isPlatformAdmin: boolean;
  ready: boolean;
  onRefused: () => void;
}

/**
 * Entry check for workflow-evaluation surfaces. Later features call this once
 * at the surface root and render nothing when access is missing.
 * Flag cache is 60 seconds; call `onRefused` when an evaluation route answers 404.
 */
export function useWorkflowEvaluationAccess(project: string | undefined): WorkflowEvaluationAccess {
  const { can, isSuperAdmin, permissionsLoaded } = useAppShell();
  const flagsQuery = useFeatureFlags(project);
  const queryClient = useQueryClient();

  const flagsSettled = !project || flagsQuery.isSuccess || flagsQuery.isError;
  const ready = permissionsLoaded && flagsSettled;
  const flagEnabled = ready
    && !flagsQuery.isError
    && (flagsQuery.flags[WORKFLOW_HUMAN_EVALUATION_FLAG] ?? false);

  const onRefused = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['feature-flags', 'evaluate', project] });
  }, [queryClient, project]);

  return {
    flagEnabled,
    canView: flagEnabled && can(WORKFLOW_EVALUATION_VIEW),
    canSubmit: flagEnabled && can(WORKFLOW_EVALUATION_SUBMIT),
    canAdmin: flagEnabled && can('admin:roles'),
    isPlatformAdmin: isSuperAdmin,
    ready,
    onRefused,
  };
}
