import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DesignPreferenceProfile,
  DesignPreferenceProfileResponse,
  DesignPreferenceProposalView,
} from '../../shared/types/designPreferenceProfile';

export function designPreferenceProfileQueryKey(settingsId: string | null | undefined) {
  return ['admin', 'project-settings', settingsId, 'design-preference-profile'] as const;
}

function profileUrl(settingsId: string): string {
  return `/api/admin/project-settings/${encodeURIComponent(settingsId)}/design-preference-profile`;
}

export interface DesignPreferenceProfileBundle {
  profile: DesignPreferenceProfileResponse;
  proposals: DesignPreferenceProposalView[];
}

export function useDesignPreferenceProfile(settingsId: string | null | undefined) {
  return useQuery<DesignPreferenceProfileBundle>({
    queryKey: designPreferenceProfileQueryKey(settingsId),
    queryFn: async () => {
      const res = await fetch(profileUrl(settingsId!), { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load design preferences');
      return res.json() as Promise<DesignPreferenceProfileBundle>;
    },
    enabled: !!settingsId,
    staleTime: 60_000,
  });
}

export function useSaveDesignPreferenceProfile() {
  const queryClient = useQueryClient();
  return useMutation<
    DesignPreferenceProfileResponse,
    Error,
    { settingsId: string; profile: DesignPreferenceProfile }
  >({
    mutationFn: async ({ settingsId, profile }) => {
      const res = await fetch(profileUrl(settingsId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(profile),
      });
      if (!res.ok) throw new Error('Could not save design preferences');
      return res.json() as Promise<DesignPreferenceProfileResponse>;
    },
    onSuccess: (_data, { settingsId }) => {
      void queryClient.invalidateQueries({ queryKey: designPreferenceProfileQueryKey(settingsId) });
    },
  });
}

export function useDecideDesignPreferenceProposal() {
  const queryClient = useQueryClient();
  return useMutation<
    DesignPreferenceProfileResponse | void,
    Error,
    { settingsId: string; proposalId: string; action: 'accept' | 'reject' }
  >({
    mutationFn: async ({ settingsId, proposalId, action }) => {
      const res = await fetch(
        `/api/admin/project-settings/${encodeURIComponent(settingsId)}/design-preference-proposals/${encodeURIComponent(proposalId)}/${action}`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) throw new Error(`Could not ${action} proposal`);
      if (action === 'accept') return res.json() as Promise<DesignPreferenceProfileResponse>;
    },
    onSuccess: (_data, { settingsId }) => {
      void queryClient.invalidateQueries({ queryKey: designPreferenceProfileQueryKey(settingsId) });
    },
  });
}
