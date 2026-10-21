import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  normalizeGenerationSoundPreferences,
  type GenerationSoundPreferences,
} from '../../shared/types/notification';
import { apiFetch } from '../utils/apiFetch';

export const GENERATION_SOUND_QUERY_KEY = ['me', 'generation-sound'] as const;

/** Server-backed so the choice follows the user across browsers and devices. */
export function useGenerationSoundSettings() {
  return useQuery<GenerationSoundPreferences>({
    queryKey: GENERATION_SOUND_QUERY_KEY,
    queryFn: async () =>
      normalizeGenerationSoundPreferences(
        await apiFetch<Partial<GenerationSoundPreferences>>('/api/me/preferences'),
      ),
    staleTime: 60_000,
  });
}

export function useUpdateGenerationSoundSettings() {
  const queryClient = useQueryClient();
  return useMutation<
    GenerationSoundPreferences,
    Error,
    Partial<GenerationSoundPreferences>,
    { previous?: GenerationSoundPreferences }
  >({
    mutationFn: async (body) =>
      normalizeGenerationSoundPreferences(
        await apiFetch<Partial<GenerationSoundPreferences>>('/api/me/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    // Toggling a switch should feel instant; roll back if the write fails.
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: GENERATION_SOUND_QUERY_KEY });
      const previous = queryClient.getQueryData<GenerationSoundPreferences>(
        GENERATION_SOUND_QUERY_KEY,
      );
      if (previous) {
        queryClient.setQueryData<GenerationSoundPreferences>(GENERATION_SOUND_QUERY_KEY, {
          ...previous,
          ...body,
        });
      }
      return { previous };
    },
    onError: (_error, _body, context) => {
      if (context?.previous) {
        queryClient.setQueryData(GENERATION_SOUND_QUERY_KEY, context.previous);
      }
    },
    onSuccess: (prefs) => {
      queryClient.setQueryData(GENERATION_SOUND_QUERY_KEY, prefs);
    },
  });
}
