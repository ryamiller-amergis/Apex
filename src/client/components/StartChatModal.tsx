import React, { useState, useEffect } from 'react';
import {
  useSkillProjects,
  useSkillRepos,
  useSkillList,
  useStartChat,
} from '../hooks/useChatThreads';
import { useAvailableModels, useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import { useAvailableModelSelection } from '../hooks/useAvailableModelSelection';
import { DEFAULT_MODEL_ID, getDefaultModelForSkill } from '../config/models';
import styles from './StartChatModal.module.css';

interface StartChatModalProps {
  onClose: () => void;
  onStarted: (threadId: string) => void;
}

export const StartChatModal: React.FC<StartChatModalProps> = ({ onClose, onStarted }) => {
  const [project, setProject] = useState('');
  const [skillPath, setSkillPath] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [transcript, setTranscript] = useState('');
  const [freeformContext, setFreeformContext] = useState('');

  const { data: projects = [], isLoading: loadingProjects } = useSkillProjects();
  const { data: skillConfig, isLoading: loadingConfig } = useProjectSkillConfig(project || null);
  const { data: repos = [], isLoading: loadingRepos } = useSkillRepos(project || null);
  const { data: skills = [], isLoading: loadingSkills } = useSkillList(
    project || null,
    skillConfig?.skillRepo ?? repos.find((r) => r.name.toLowerCase() === project.toLowerCase())?.name ?? repos[0]?.name ?? null,
    skillConfig?.skillBranch ?? undefined,
  );
  const startChat = useStartChat();
  const { data: availableModels = [], isLoading: loadingModels } = useAvailableModels();
  useAvailableModelSelection(model, setModel, availableModels);

  // Resolve repo + branch from admin config, falling back to heuristic
  const fallbackRepo = repos.find((r) => r.name.toLowerCase() === project.toLowerCase()) ?? repos[0];
  const resolvedRepo = skillConfig?.skillRepo ?? fallbackRepo?.name ?? null;
  const resolvedBranch = skillConfig?.skillBranch ?? fallbackRepo?.defaultBranch ?? 'main';
  const hasConfig = !!skillConfig;

  // When skill selection changes, apply the skill's declared model if present
  const selectedSkill = skills.find((s) => s.path === skillPath);
  useEffect(() => {
    if (selectedSkill) {
      setModel(getDefaultModelForSkill(selectedSkill as unknown as Record<string, unknown>));
    }
  }, [skillPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const canStart = !!project && !!resolvedRepo && !startChat.isPending && !loadingConfig && !loadingRepos;

  const handleProjectChange = (val: string) => {
    setProject(val);
    setSkillPath('');
  };

  const handleStart = async () => {
    if (!canStart || !resolvedRepo) return;
    try {
      const result = await startChat.mutateAsync({
        kickoff: {
          project,
          repo: resolvedRepo,
          branch: resolvedBranch,
          skillPath,
          model,
          transcript: transcript.trim() || undefined,
          freeformContext: freeformContext.trim() || undefined,
        },
      });
      onStarted(result.threadId);
    } catch {
      // error shown via startChat.error
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="start-chat-title">
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title} id="start-chat-title">
            Start Agent Chat
          </h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className={styles.body}>
          {/* Project */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="sc-project">Project</label>
            <select
              id="sc-project"
              className={styles.select}
              value={project}
              onChange={(e) => handleProjectChange(e.target.value)}
              disabled={loadingProjects}
            >
              <option value="">
                {loadingProjects ? 'Loading…' : '— Select project —'}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Resolved repo + branch (read-only info) */}
          {project && (
            <div className={styles.field}>
              <label className={styles.label}>Repository &amp; Branch</label>
              {loadingConfig || loadingRepos ? (
                <p className={styles.hint}>Resolving…</p>
              ) : resolvedRepo ? (
                <p className={styles.hint}>
                  <strong>{resolvedRepo}</strong> @ <code style={{ fontFamily: 'monospace', background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border-color-light)' }}>{resolvedBranch}</code>
                  {hasConfig
                    ? <span style={{ color: 'var(--success-color)', marginLeft: 8 }}>✓ admin config</span>
                    : <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>(auto-detected)</span>}
                </p>
              ) : (
                <p className={styles.hint} style={{ color: 'var(--error-color)' }}>
                  No skill config found for this project. Contact an admin.
                </p>
              )}
            </div>
          )}

          {/* Skill (optional) */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="sc-skill">
              Skill <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional — or invoke later with /)</span>
            </label>
            <select
              id="sc-skill"
              className={styles.select}
              value={skillPath}
              onChange={(e) => setSkillPath(e.target.value)}
              disabled={!resolvedRepo || loadingSkills}
            >
              <option value="">
                {loadingSkills ? 'Loading skills…' : skills.length === 0 && resolvedRepo ? 'No skills found' : '— Free chat (no skill) —'}
              </option>
              {skills.map((s) => (
                <option key={s.id} value={s.path} title={s.description}>
                  {s.name}
                </option>
              ))}
            </select>
            {skillPath && skills.find((s) => s.path === skillPath)?.description && (
              <p className={styles.hint}>
                {skills.find((s) => s.path === skillPath)!.description}
              </p>
            )}
            {!skillPath && resolvedRepo && (
              <p className={styles.hint}>
                Starts an open-ended chat. Type <code style={{ fontFamily: 'monospace', background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3, border: '1px solid var(--border-color-light)' }}>/</code> in the chat input at any time to invoke a skill.
              </p>
            )}
          </div>

          {/* Model */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="sc-model">Model</label>
            <select
              id="sc-model"
              className={styles.select}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {loadingModels || availableModels.length === 0 ? (
                <option value={model}>Loading models…</option>
              ) : (
                availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))
              )}
            </select>
          </div>

          {/* Transcript */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="sc-transcript">
              Prior chat transcript <span style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              id="sc-transcript"
              className={styles.textarea}
              placeholder="Paste a prior Cursor chat transcript, meeting notes, or any context the skill should start from…"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={5}
            />
          </div>

          {/* Freeform context */}
          <div className={styles.field}>
            <label className={styles.label} htmlFor="sc-context">
              Additional context <span style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              id="sc-context"
              className={styles.textarea}
              placeholder="Any other context, constraints, or notes for the agent…"
              value={freeformContext}
              onChange={(e) => setFreeformContext(e.target.value)}
              rows={3}
            />
          </div>

          {startChat.error && (
            <div className={styles.error}>{startChat.error.message}</div>
          )}
        </div>

        <div className={styles.footer}>
          <button className={styles.btnCancel} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.btnPrimary}
            onClick={handleStart}
            disabled={!canStart}
          >
            {startChat.isPending ? 'Starting…' : skillPath ? 'Start Chat with Skill' : 'Start Chat'}
          </button>
        </div>
      </div>
    </div>
  );
};
