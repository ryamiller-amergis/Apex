import { useCancelBuild, useResumeBuild } from './useBuilds';

export function useBuildRunControls(project: string, buildId: string) {
  const cancelMutation = useCancelBuild(project, buildId);
  const resumeMutation = useResumeBuild(project, buildId);

  return {
    cancelBuild: (reason?: string) =>
      cancelMutation.mutateAsync(reason ? { reason } : {}),
    resumeBuild: () => resumeMutation.mutateAsync({}),
    isCancelling: cancelMutation.isPending,
    isResuming: resumeMutation.isPending,
  };
}
