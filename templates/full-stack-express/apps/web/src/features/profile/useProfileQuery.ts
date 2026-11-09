import { useQuery } from '@tanstack/react-query';
import { getMe } from '../../api/apiClient';
import { profileKeys } from './profileKeys';

export function useProfileQuery(enabled = true) {
  return useQuery({
    queryKey: profileKeys.me,
    queryFn: () => getMe(),
    retry: false,
    enabled,
  });
}
