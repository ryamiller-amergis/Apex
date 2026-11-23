import { useCallback, useState } from 'react';
import type { AgentComposerModelOption } from '../components/agentChat/AgentComposer';
import { DEFAULT_MODEL_ID } from '../config/models';
import { useAvailableModelSelection } from './useAvailableModelSelection';
import { useAvailableModels, useGlobalDefaultModel } from './useProjectSkillConfig';

/** Composer props for the model dropdown. Spread the result into `AgentHarnessPanel`'s `composer`. */
export interface HarnessModelPicker {
  model: string;
  models: AgentComposerModelOption[];
  modelsLoading: boolean;
  onModelChange: (modelId: string) => void;
}

/**
 * The model dropdown every chat area shows. The preferred model is the thread's
 * model, then the admin default, then `DEFAULT_MODEL_ID`. A user pick holds only
 * while that source stays the same, so opening another thread or an admin default
 * change resets the selection.
 */
export function useHarnessModelPicker(threadModel?: string | null): HarnessModelPicker {
  const { data: availableModels, isLoading } = useAvailableModels();
  const { data: globalDefault } = useGlobalDefaultModel();
  const preferred = threadModel?.trim() || globalDefault?.value || DEFAULT_MODEL_ID;
  const sourceKey = `${threadModel?.trim() ?? ''}\u0000${globalDefault?.value ?? ''}`;

  const [pick, setPick] = useState<{ sourceKey: string; model: string } | null>(null);
  const model = pick && pick.sourceKey === sourceKey ? pick.model : preferred;

  const onModelChange = useCallback(
    (modelId: string) => setPick({ sourceKey, model: modelId }),
    [sourceKey],
  );
  useAvailableModelSelection(model, onModelChange, availableModels);

  return {
    model,
    models: availableModels ?? [],
    modelsLoading: isLoading,
    onModelChange,
  };
}
