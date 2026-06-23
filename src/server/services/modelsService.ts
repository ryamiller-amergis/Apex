import { Cursor } from '@cursor/sdk';

export interface AvailableModel {
  id: string;
  displayName: string;
}

let modelsCache: AvailableModel[] | null = null;
let modelsCacheExpiry = 0;
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchAvailableModels(): Promise<AvailableModel[]> {
  const now = Date.now();
  if (modelsCache && now < modelsCacheExpiry) return modelsCache;

  try {
    const result = await Cursor.models.list();
    const models: AvailableModel[] = (result ?? []).map((m: { id: string; displayName?: string }) => ({
      id: m.id,
      displayName: m.displayName ?? m.id,
    }));
    modelsCache = models;
    modelsCacheExpiry = now + MODELS_CACHE_TTL_MS;
    return models;
  } catch {
    return modelsCache ?? [];
  }
}
