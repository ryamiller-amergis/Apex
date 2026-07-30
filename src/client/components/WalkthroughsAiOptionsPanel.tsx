import React, { useMemo } from 'react';
import {
  APEX_WALKTHROUGH_AI_PROJECT,
  DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH,
  useWalkthroughsAiOptions,
} from '../contexts/WalkthroughsAiOptionsContext';
import { DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH } from '../../shared/types/walkthroughAnchorSmartTagging';
import { AGENT_MODELS } from '../config/models';
import {
  useAvailableModels,
  useProjectSkillConfig,
} from '../hooks/useProjectSkillConfig';
import { useSkillList, useSkillRepos } from '../hooks/useChatThreads';
import styles from './WalkthroughAnchorManagement.module.css';

function formatSavedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Platform Admin → Walkthroughs → Options.
 * Persists skill + agent model per AI process with who/when audit.
 */
export const WalkthroughsAiOptionsPanel: React.FC = () => {
  const {
    walkthroughGenerationModel,
    anchorSmartTaggingModel,
    walkthroughGenerationSkillPath,
    anchorSmartTaggingSkillPath,
    setWalkthroughGenerationModel,
    setAnchorSmartTaggingModel,
    setWalkthroughGenerationSkillPath,
    setAnchorSmartTaggingSkillPath,
    savedRecord,
    isLoading,
    isSaving,
    isDirty,
    saveError,
    loadError,
    save,
  } = useWalkthroughsAiOptions();

  const modelsQuery = useAvailableModels();
  const skillConfigQuery = useProjectSkillConfig(APEX_WALKTHROUGH_AI_PROJECT);
  const skillConfig = skillConfigQuery.data;
  const skillReposQuery = useSkillRepos(
    APEX_WALKTHROUGH_AI_PROJECT,
    skillConfig?.skillProvider,
  );
  const skillRepo =
    skillConfig?.skillRepo ||
    skillReposQuery.data?.find(
      (repo) => repo.name.toLowerCase() === APEX_WALKTHROUGH_AI_PROJECT.toLowerCase(),
    )?.name ||
    skillReposQuery.data?.[0]?.name ||
    null;
  const skillBranch =
    skillConfig?.skillBranch ||
    skillReposQuery.data?.find((repo) => repo.name === skillRepo)?.defaultBranch;
  const skillsQuery = useSkillList(
    APEX_WALKTHROUGH_AI_PROJECT,
    skillRepo,
    skillBranch,
    skillConfig?.skillProvider,
  );

  const skills = skillsQuery.data ?? [];
  const agentModels = useMemo(() => {
    const fromApi = modelsQuery.data ?? [];
    if (fromApi.length > 0) return fromApi;
    return AGENT_MODELS.map((m) => ({ id: m.id, displayName: m.label }));
  }, [modelsQuery.data]);

  return (
    <section
      className={styles.section}
      {...{ 'data-testid': 'walkthroughs-ai-options' }}
    >
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>AI Options</h2>
          <p className={styles.hint}>
            Choose the skill and agent model for each walkthrough AI process, then Save.
            Saved values are used the next time that process starts.
          </p>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={isLoading || isSaving || !isDirty}
            onClick={() => {
              void save();
            }}
            {...{ 'data-testid': 'walkthroughs-ai-options-save' }}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {isLoading && (
        <p className={styles.hint} {...{ 'data-testid': 'walkthroughs-ai-options-loading' }}>
          Loading saved options…
        </p>
      )}
      {loadError && (
        <p className={styles.warningText} role="alert">
          {loadError}
        </p>
      )}
      {saveError && (
        <p
          className={styles.warningText}
          role="alert"
          {...{ 'data-testid': 'walkthroughs-ai-options-save-error' }}
        >
          {saveError}
        </p>
      )}

      {savedRecord && (
        <p
          className={styles.optionsMeta}
          {...{ 'data-testid': 'walkthroughs-ai-options-meta' }}
        >
          Last saved by {savedRecord.updatedByDisplayName} on{' '}
          {formatSavedAt(savedRecord.updatedAt)}
          {isDirty ? ' · Unsaved changes' : ''}
        </p>
      )}

      <div className={styles.optionsCard}>
        <fieldset className={styles.optionsGroup}>
          <legend className={styles.optionsGroupTitle}>Walkthrough generation</legend>
          <p className={styles.optionsHint}>
            Used when generating a walkthrough draft from the editor.
          </p>

          <div className={styles.optionsField}>
            <label
              className={styles.optionsLabel}
              htmlFor="walkthroughs-ai-generation-skill"
            >
              Skill
            </label>
            <select
              id="walkthroughs-ai-generation-skill"
              className={styles.optionsSelect}
              value={walkthroughGenerationSkillPath}
              onChange={(e) => setWalkthroughGenerationSkillPath(e.target.value)}
              disabled={skillsQuery.isLoading || isSaving}
              {...{ 'data-testid': 'walkthroughs-ai-options-generation-skill' }}
            >
              <option value={DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH}>
                Walkthrough generation (default)
              </option>
              {skills
                .filter((skill) => skill.path !== DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH)
                .map((skill) => (
                  <option key={skill.id} value={skill.path}>
                    {skill.name}
                  </option>
                ))}
            </select>
          </div>

          <div className={styles.optionsField}>
            <label
              className={styles.optionsLabel}
              htmlFor="walkthroughs-ai-generation-model"
            >
              Agent model
            </label>
            <select
              id="walkthroughs-ai-generation-model"
              className={styles.optionsSelect}
              value={walkthroughGenerationModel}
              onChange={(e) => setWalkthroughGenerationModel(e.target.value)}
              disabled={(modelsQuery.isLoading && agentModels.length === 0) || isSaving}
              title="Agent model for walkthrough generation"
              aria-label="Walkthrough generation agent model"
              {...{ 'data-testid': 'walkthroughs-ai-options-generation-model' }}
            >
              <option value="">Project / platform default</option>
              {agentModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        <fieldset className={styles.optionsGroup}>
          <legend className={styles.optionsGroupTitle}>Anchor smart-tagging</legend>
          <p className={styles.optionsHint}>
            Used after Sync when newly discovered anchors are sent for tags, route, and
            placement suggestions.
          </p>

          <div className={styles.optionsField}>
            <label
              className={styles.optionsLabel}
              htmlFor="walkthroughs-ai-smart-tagging-skill"
            >
              Skill
            </label>
            <select
              id="walkthroughs-ai-smart-tagging-skill"
              className={styles.optionsSelect}
              value={anchorSmartTaggingSkillPath}
              onChange={(e) => setAnchorSmartTaggingSkillPath(e.target.value)}
              disabled={skillsQuery.isLoading || isSaving}
              {...{ 'data-testid': 'walkthroughs-ai-options-smart-tagging-skill' }}
            >
              <option value={DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH}>
                Anchor smart-tagging (default)
              </option>
              {skills
                .filter(
                  (skill) =>
                    skill.path !== DEFAULT_WALKTHROUGH_ANCHOR_SMART_TAGGING_SKILL_PATH,
                )
                .map((skill) => (
                  <option key={`smart-${skill.id}`} value={skill.path}>
                    {skill.name}
                  </option>
                ))}
            </select>
          </div>

          <div className={styles.optionsField}>
            <label
              className={styles.optionsLabel}
              htmlFor="walkthroughs-ai-smart-tagging-model"
            >
              Agent model
            </label>
            <select
              id="walkthroughs-ai-smart-tagging-model"
              className={styles.optionsSelect}
              value={anchorSmartTaggingModel}
              onChange={(e) => setAnchorSmartTaggingModel(e.target.value)}
              disabled={(modelsQuery.isLoading && agentModels.length === 0) || isSaving}
              title="Agent model for anchor smart-tagging"
              aria-label="Anchor smart-tagging agent model"
              {...{ 'data-testid': 'walkthroughs-ai-options-smart-tagging-model' }}
            >
              <option value="">Project / platform default</option>
              {agentModels.map((m) => (
                <option key={`smart-model-${m.id}`} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        {skillsQuery.isError && (
          <p className={styles.warningText} role="alert">
            Could not load skills from the Apex project connection. Defaults still apply
            until the connection is available.
          </p>
        )}
        {modelsQuery.isError && (
          <p className={styles.hint}>
            Live model list unavailable — showing curated Cursor agent models instead.
          </p>
        )}
      </div>
    </section>
  );
};
