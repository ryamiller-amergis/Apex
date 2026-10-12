import { useEffect } from 'react';
import {
  resolveAvailableModelId,
  type ModelOption,
} from '../../shared/utils/modelAvailability';

/**
 * Keep a model selection on a model the Cursor SDK currently offers. A saved
 * default that was retired moves to the closest available model.
 */
export function useAvailableModelSelection(
  model: string,
  setModel: (id: string) => void,
  models: ReadonlyArray<ModelOption> | undefined,
): void {
  useEffect(() => {
    if (!models?.length) return;
    const resolved = resolveAvailableModelId(model, models);
    if (resolved !== model) setModel(resolved);
  }, [model, models, setModel]);
}
