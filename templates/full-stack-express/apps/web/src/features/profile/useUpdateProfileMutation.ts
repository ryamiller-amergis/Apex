import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UpdateProfileBody } from '@project-scope/contracts';
import { putMe } from '../../api/apiClient';
import { profileKeys } from './profileKeys';

export function useUpdateProfileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileBody) => putMe(body),
    onSuccess: (profile) => {
      queryClient.setQueryData(profileKeys.me, profile);
      void queryClient.invalidateQueries({ queryKey: profileKeys.me });
    },
  });
}
