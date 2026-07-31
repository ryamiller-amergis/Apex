import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH,
  DEFAULT_WALKTHROUGH_ANCHOR_DISCOVERY_SKILL_PATH_FOR_OPTIONS,
  defaultWalkthroughAiOptionsRecord,
  type WalkthroughAiOptionsRecord,
} from '../../shared/types/walkthroughAiOptions';
import { DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH } from '../../shared/types/walkthroughAnchorSmartTagging';
import {
  useSaveWalkthroughAiOptions,
  useWalkthroughAiOptionsQuery,
} from '../hooks/useWalkthroughAiOptions';

export { DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH };
export const APEX_WALKTHROUGH_AI_PROJECT = 'Apex';

export interface WalkthroughsAiOptions {
  walkthroughGenerationModel: string;
  anchorSmartTaggingModel: string;
  anchorDiscoveryModel: string;
  walkthroughGenerationSkillPath: string;
  anchorSmartTaggingSkillPath: string;
  anchorDiscoverySkillPath: string;
}

export interface WalkthroughsAiOptionsContextValue extends WalkthroughsAiOptions {
  setWalkthroughGenerationModel: (model: string) => void;
  setAnchorSmartTaggingModel: (model: string) => void;
  setAnchorDiscoveryModel: (model: string) => void;
  setWalkthroughGenerationSkillPath: (skillPath: string) => void;
  setAnchorSmartTaggingSkillPath: (skillPath: string) => void;
  setAnchorDiscoverySkillPath: (skillPath: string) => void;
  /** Last persisted row (who / when). Null until loaded or never saved beyond seed. */
  savedRecord: WalkthroughAiOptionsRecord | null;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;
  saveError: string | null;
  loadError: string | null;
  save: () => Promise<WalkthroughAiOptionsRecord | null>;
}

export const DEFAULT_WALKTHROUGHS_AI_OPTIONS: WalkthroughsAiOptions = {
  walkthroughGenerationModel: '',
  anchorSmartTaggingModel: '',
  anchorDiscoveryModel: '',
  walkthroughGenerationSkillPath: DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH,
  anchorSmartTaggingSkillPath: DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
  anchorDiscoverySkillPath: DEFAULT_WALKTHROUGH_ANCHOR_DISCOVERY_SKILL_PATH_FOR_OPTIONS,
};

function recordToDraft(record: WalkthroughAiOptionsRecord): WalkthroughsAiOptions {
  return {
    walkthroughGenerationModel: record.walkthroughGenerationModel ?? '',
    anchorSmartTaggingModel: record.anchorSmartTaggingModel ?? '',
    anchorDiscoveryModel: record.anchorDiscoveryModel ?? '',
    walkthroughGenerationSkillPath: record.walkthroughGenerationSkillPath,
    anchorSmartTaggingSkillPath: record.anchorSmartTaggingSkillPath,
    anchorDiscoverySkillPath: record.anchorDiscoverySkillPath,
  };
}

const WalkthroughsAiOptionsContext =
  createContext<WalkthroughsAiOptionsContextValue | null>(null);

export const WalkthroughsAiOptionsProvider: React.FC<{
  children: React.ReactNode;
  /** Test override — skips live query when provided. */
  initial?: Partial<WalkthroughsAiOptions>;
  initialSavedRecord?: WalkthroughAiOptionsRecord | null;
}> = ({ children, initial, initialSavedRecord }) => {
  const optionsQuery = useWalkthroughAiOptionsQuery();
  const saveMutation = useSaveWalkthroughAiOptions();
  const hydratedFromServer = useRef(false);

  const [walkthroughGenerationModel, setWalkthroughGenerationModel] = useState(
    initial?.walkthroughGenerationModel ??
      DEFAULT_WALKTHROUGHS_AI_OPTIONS.walkthroughGenerationModel,
  );
  const [anchorSmartTaggingModel, setAnchorSmartTaggingModel] = useState(
    initial?.anchorSmartTaggingModel ??
      DEFAULT_WALKTHROUGHS_AI_OPTIONS.anchorSmartTaggingModel,
  );
  const [anchorDiscoveryModel, setAnchorDiscoveryModel] = useState(
    initial?.anchorDiscoveryModel ?? DEFAULT_WALKTHROUGHS_AI_OPTIONS.anchorDiscoveryModel,
  );
  const [walkthroughGenerationSkillPath, setWalkthroughGenerationSkillPath] = useState(
    initial?.walkthroughGenerationSkillPath ??
      DEFAULT_WALKTHROUGHS_AI_OPTIONS.walkthroughGenerationSkillPath,
  );
  const [anchorSmartTaggingSkillPath, setAnchorSmartTaggingSkillPath] = useState(
    initial?.anchorSmartTaggingSkillPath ??
      DEFAULT_WALKTHROUGHS_AI_OPTIONS.anchorSmartTaggingSkillPath,
  );
  const [anchorDiscoverySkillPath, setAnchorDiscoverySkillPath] = useState(
    initial?.anchorDiscoverySkillPath ??
      DEFAULT_WALKTHROUGHS_AI_OPTIONS.anchorDiscoverySkillPath,
  );
  const [savedRecord, setSavedRecord] = useState<WalkthroughAiOptionsRecord | null>(
    initialSavedRecord ?? null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    if (!optionsQuery.data || hydratedFromServer.current) return;
    hydratedFromServer.current = true;
    const draft = recordToDraft(optionsQuery.data);
    // One-time hydrate of editable draft from server query (guarded by hydratedFromServer).
    /* eslint-disable react-hooks/set-state-in-effect -- intentional one-shot server→draft hydrate */
    setWalkthroughGenerationModel(draft.walkthroughGenerationModel);
    setAnchorSmartTaggingModel(draft.anchorSmartTaggingModel);
    setAnchorDiscoveryModel(draft.anchorDiscoveryModel);
    setWalkthroughGenerationSkillPath(draft.walkthroughGenerationSkillPath);
    setAnchorSmartTaggingSkillPath(draft.anchorSmartTaggingSkillPath);
    setAnchorDiscoverySkillPath(draft.anchorDiscoverySkillPath);
    setSavedRecord(optionsQuery.data);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initial, optionsQuery.data]);

  const isDirty = useMemo(() => {
    const baseline = savedRecord
      ? recordToDraft(savedRecord)
      : DEFAULT_WALKTHROUGHS_AI_OPTIONS;
    return (
      walkthroughGenerationModel !== baseline.walkthroughGenerationModel ||
      anchorSmartTaggingModel !== baseline.anchorSmartTaggingModel ||
      anchorDiscoveryModel !== baseline.anchorDiscoveryModel ||
      walkthroughGenerationSkillPath !== baseline.walkthroughGenerationSkillPath ||
      anchorSmartTaggingSkillPath !== baseline.anchorSmartTaggingSkillPath ||
      anchorDiscoverySkillPath !== baseline.anchorDiscoverySkillPath
    );
  }, [
    savedRecord,
    walkthroughGenerationModel,
    anchorSmartTaggingModel,
    anchorDiscoveryModel,
    walkthroughGenerationSkillPath,
    anchorSmartTaggingSkillPath,
    anchorDiscoverySkillPath,
  ]);

  const save = useCallback(async () => {
    setSaveError(null);
    try {
      const saved = await saveMutation.mutateAsync({
        walkthroughGenerationSkillPath,
        walkthroughGenerationModel,
        anchorSmartTaggingSkillPath,
        anchorSmartTaggingModel,
        anchorDiscoverySkillPath,
        anchorDiscoveryModel,
      });
      setSavedRecord(saved);
      return saved;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to save walkthrough AI options';
      setSaveError(message);
      return null;
    }
  }, [
    saveMutation,
    walkthroughGenerationSkillPath,
    walkthroughGenerationModel,
    anchorSmartTaggingSkillPath,
    anchorSmartTaggingModel,
    anchorDiscoverySkillPath,
    anchorDiscoveryModel,
  ]);

  const value = useMemo<WalkthroughsAiOptionsContextValue>(
    () => ({
      walkthroughGenerationModel,
      anchorSmartTaggingModel,
      anchorDiscoveryModel,
      walkthroughGenerationSkillPath,
      anchorSmartTaggingSkillPath,
      anchorDiscoverySkillPath,
      setWalkthroughGenerationModel,
      setAnchorSmartTaggingModel,
      setAnchorDiscoveryModel,
      setWalkthroughGenerationSkillPath,
      setAnchorSmartTaggingSkillPath,
      setAnchorDiscoverySkillPath,
      savedRecord,
      isLoading: !initial && optionsQuery.isLoading,
      isSaving: saveMutation.isPending,
      isDirty,
      saveError,
      loadError:
        !initial && optionsQuery.isError
          ? optionsQuery.error instanceof Error
            ? optionsQuery.error.message
            : 'Failed to load walkthrough AI options'
          : null,
      save,
    }),
    [
      walkthroughGenerationModel,
      anchorSmartTaggingModel,
      anchorDiscoveryModel,
      walkthroughGenerationSkillPath,
      anchorSmartTaggingSkillPath,
      anchorDiscoverySkillPath,
      savedRecord,
      initial,
      optionsQuery.isLoading,
      optionsQuery.isError,
      optionsQuery.error,
      saveMutation.isPending,
      isDirty,
      saveError,
      save,
    ],
  );

  return (
    <WalkthroughsAiOptionsContext.Provider value={value}>
      {children}
    </WalkthroughsAiOptionsContext.Provider>
  );
};

/**
 * Options selected on Platform Admin → Walkthroughs → Options.
 * Falls back to defaults when rendered outside the provider (unit tests / standalone editor).
 */
export function useWalkthroughsAiOptions(): WalkthroughsAiOptionsContextValue {
  const ctx = useContext(WalkthroughsAiOptionsContext);
  if (ctx) return ctx;
  const fallback = defaultWalkthroughAiOptionsRecord();
  return {
    ...DEFAULT_WALKTHROUGHS_AI_OPTIONS,
    setWalkthroughGenerationModel: () => undefined,
    setAnchorSmartTaggingModel: () => undefined,
    setAnchorDiscoveryModel: () => undefined,
    setWalkthroughGenerationSkillPath: () => undefined,
    setAnchorSmartTaggingSkillPath: () => undefined,
    setAnchorDiscoverySkillPath: () => undefined,
    savedRecord: fallback,
    isLoading: false,
    isSaving: false,
    isDirty: false,
    saveError: null,
    loadError: null,
    save: async () => null,
  };
}
