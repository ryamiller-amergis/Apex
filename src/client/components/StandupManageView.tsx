import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useGroups } from '../hooks/useGroups';
import { useProjects, useProjectAreaPaths } from '../hooks/useProjects';
import { useStandupRosterPreview } from '../hooks/useStandupDeliveryPulse';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { NumberStepper } from './NumberStepper';
import {
  formatDurationLabel,
  minuteOptionsForValue,
  parseScheduleTime,
  toScheduleTime,
} from '../utils/standupTiming';
import {
  STANDUP_DELIVERY_MODEL_LABELS,
  STANDUP_ROSTER_MODE_LABELS,
  STANDUP_ROSTER_MODE_SHORT_LABELS,
  type StandupDeliveryModel,
  type StandupDeliveryPolicy,
  type StandupGoalSource,
  type StandupRosterMode,
} from '../../shared/types/standup';
import { resolveStandupPolicy } from '../../shared/utils/standupDeliveryPolicy';
import styles from './StandupManageView.module.css';

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Honolulu',
  'America/Phoenix',
  'America/Toronto',
  'America/Vancouver',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Warsaw',
  'Europe/Stockholm',
  'Europe/Helsinki',
  'Europe/Athens',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Pacific/Auckland',
  'Pacific/Fiji',
  'UTC',
];

const DELIVERY_MODEL_OPTIONS: Array<{
  value: StandupDeliveryModel;
  label: string;
}> = [
  {
    value: 'flow',
    label: 'Flow / Kanban (Default — aging, WIP & blockers; no target dates)',
  },
  {
    value: 'sprint',
    label: 'Sprint / Iteration (iteration scope & sprint goal)',
  },
  {
    value: 'milestone',
    label: 'Milestone / Release (target dates & release epics)',
  },
  {
    value: 'support',
    label: 'Support / Operations (priority & SLA age)',
  },
  {
    value: 'custom',
    label: 'Custom Policy',
  },
];

const ROSTER_MODE_OPTIONS: Array<{
  value: StandupRosterMode;
  label: string;
}> = [
  {
    value: 'ado_and_groups',
    label: STANDUP_ROSTER_MODE_LABELS.ado_and_groups,
  },
  {
    value: 'ado_active',
    label: STANDUP_ROSTER_MODE_LABELS.ado_active,
  },
  {
    value: 'groups_only',
    label: STANDUP_ROSTER_MODE_LABELS.groups_only,
  },
];

const GOAL_SOURCE_OPTIONS: Array<{ value: StandupGoalSource; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'manual', label: 'Manual Team Goal' },
  { value: 'iteration', label: 'Current Sprint / Iteration' },
  { value: 'release_epic', label: 'Upcoming Release Epic' },
  { value: 'saved_query', label: 'Saved ADO Query' },
];

interface StandupConfig {
  id: string;
  groupId: string | null;
  groupIds: string[];
  project: string;
  areaPath: string | null;
  iterationMode: string;
  iterationPath: string | null;
  scheduleTime: string;
  timezone: string;
  weekdays: number[];
  skillSettingsId: string | null;
  enabled: boolean;
  deliveryModel?: StandupDeliveryModel;
  goalSource?: StandupGoalSource;
  teamGoal?: string | null;
  rosterMode?: StandupRosterMode;
  policy?: Partial<StandupDeliveryPolicy>;
  reminderDelayMin?: number;
  reminderIntervalMin?: number;
  facilitatorDeadlineMin?: number;
  group?: { id: string; name: string };
  groups?: Array<{ id: string; name: string }>;
}

interface StandupSession {
  id: string;
  configId: string;
  sessionDate: string;
  status: string;
  participants: Array<{
    id: string;
    userId: string;
    status: string;
    submittedAt: string | null;
  }>;
  followups: Array<{
    id: string;
    title: string;
    status: string;
  }>;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

interface ScheduleTimeControlProps {
  value: string;
  onChange: (value: string) => void;
  'data-testid'?: string;
}

const ScheduleTimeControl: React.FC<ScheduleTimeControlProps> = ({
  value,
  onChange,
  'data-testid': testId = 'standup-schedule-time',
}) => {
  const { hour12, minute, period } = parseScheduleTime(value);
  const minuteOptions = minuteOptionsForValue(minute);

  const update = (
    next: Partial<{ hour12: number; minute: number; period: 'AM' | 'PM' }>,
  ) => {
    onChange(
      toScheduleTime(
        next.hour12 ?? hour12,
        next.minute ?? minute,
        next.period ?? period,
      ),
    );
  };

  return (
    <div className={styles.timingCard} data-testid={testId}>
      <span className={styles.timingCardLabel}>Schedule time</span>
      <div className={styles.timeControl}>
        <select
          className={styles.timeSelect}
          value={hour12}
          onChange={(e) => update({ hour12: Number(e.target.value) })}
          aria-label="Hour"
          data-testid={`${testId}-hour`}
        >
          {HOUR_OPTIONS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <span className={styles.timeSeparator}>:</span>
        <select
          className={styles.timeSelect}
          value={minute}
          onChange={(e) => update({ minute: Number(e.target.value) })}
          aria-label="Minute"
          data-testid={`${testId}-minute`}
        >
          {minuteOptions.map((m) => (
            <option key={m} value={m}>
              {String(m).padStart(2, '0')}
            </option>
          ))}
        </select>
        <div className={styles.periodToggle} role="group" aria-label="AM or PM">
          {(['AM', 'PM'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={`${styles.periodBtn} ${period === p ? styles.periodBtnActive : ''}`}
              onClick={() => update({ period: p })}
              aria-pressed={period === p}
              data-testid={`${testId}-period-${p.toLowerCase()}`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <span className={styles.fieldHint}>
        When the standup session starts on scheduled days
      </span>
    </div>
  );
};

interface DurationControlProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  presets: number[];
  onChange: (value: number) => void;
  'data-testid'?: string;
}

const DurationControl: React.FC<DurationControlProps> = ({
  label,
  hint,
  value,
  min,
  max = 480,
  step = 5,
  presets,
  onChange,
  'data-testid': testId = 'standup-duration',
}) => {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  return (
    <div className={styles.timingCard} data-testid={testId}>
      <span className={styles.timingCardLabel}>{label}</span>
      <div className={styles.durationStepper}>
        <button
          type="button"
          className={styles.stepperBtn}
          onClick={() => onChange(clamp(value - step))}
          disabled={value <= min}
          aria-label={`Decrease ${label}`}
          data-testid={`${testId}-decrease`}
        >
          −
        </button>
        <div className={styles.stepperValueWrap}>
          <span className={styles.stepperValue}>{value}</span>
          <span className={styles.stepperUnit}>min</span>
        </div>
        <button
          type="button"
          className={styles.stepperBtn}
          onClick={() => onChange(clamp(value + step))}
          disabled={value >= max}
          aria-label={`Increase ${label}`}
          data-testid={`${testId}-increase`}
        >
          +
        </button>
      </div>
      <div
        className={styles.presetChips}
        role="group"
        aria-label={`${label} presets`}
      >
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`${styles.presetChip} ${value === preset ? styles.presetChipActive : ''}`}
            onClick={() => onChange(preset)}
            aria-pressed={value === preset}
            data-testid={`${testId}-preset-${preset}`}
          >
            {formatDurationLabel(preset)}
          </button>
        ))}
      </div>
      <span className={styles.fieldHint}>{hint}</span>
    </div>
  );
};

const InfoIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
    <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
  </svg>
);

const StandupSubNav: React.FC = () => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  return (
    <div className={styles.subNav}>
      <button
        type="button"
        className={styles.subNavBtn}
        onClick={() => navigate('/standup')}
        data-testid="standup-manage-subnav-my-standup"
      >
        My Standup
      </button>
      {can('standup:participate') && (
        <button
          type="button"
          className={styles.subNavBtn}
          onClick={() => navigate('/standup-summary')}
          data-testid="standup-manage-subnav-summary"
        >
          Summary
        </button>
      )}
      <button
        type="button"
        className={`${styles.subNavBtn} ${styles.subNavActive}`}
        onClick={() => navigate('/standup-manage')}
        data-testid="standup-manage-subnav-manage"
      >
        Manage
      </button>
    </div>
  );
};

function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function readStandupError(body: unknown, label: string): string {
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'string'
  ) {
    return (body as { error: string }).error;
  }
  return `Could not load ${label}.`;
}

function makeDefaultFormState(project: string) {
  return {
    groupIds: [] as string[],
    project,
    areaPath: '',
    scheduleTime: '09:00',
    timezone: 'America/New_York',
    weekdays: [1, 2, 3, 4, 5] as number[],
    enabled: true,
    deliveryModel: 'flow' as StandupDeliveryModel,
    goalSource: 'none' as StandupGoalSource,
    teamGoal: '',
    rosterMode: 'ado_and_groups' as StandupRosterMode,
    policy: resolveStandupPolicy('flow'),
    reminderDelayMin: 30,
    reminderIntervalMin: 60,
    facilitatorDeadlineMin: 120,
  };
}

export const StandupManageView: React.FC = () => {
  const [configs, setConfigs] = useState<StandupConfig[]>([]);
  const [sessions, setSessions] = useState<StandupSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{
    id: string;
    sessionDate: string;
  } | null>(null);
  const [pendingDeleteConfig, setPendingDeleteConfig] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [isDeletingConfig, setIsDeletingConfig] = useState(false);
  const [showManageInfo, setShowManageInfo] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { selectedProject } = useAppShell();
  const [formData, setFormData] = useState(() =>
    makeDefaultFormState(selectedProject || ''),
  );

  const { data: adoProjects = [] } = useProjects();
  const { data: groups = [], isLoading: groupsLoading } = useGroups(
    formData.project || undefined,
  );
  const { data: areaPaths = [], isLoading: areaPathsLoading } =
    useProjectAreaPaths(formData.project || null);
  const { data: rosterPreview } = useStandupRosterPreview({
    project: formData.project,
    areaPath: formData.areaPath || undefined,
    rosterMode: formData.rosterMode,
    groupIds: formData.groupIds,
    enabled: showForm && Boolean(formData.project),
  });

  const toggleGroup = useCallback((groupId: string) => {
    setFormData((prev) => ({
      ...prev,
      groupIds: prev.groupIds.includes(groupId)
        ? prev.groupIds.filter((id) => id !== groupId)
        : [...prev.groupIds, groupId],
    }));
  }, []);

  const handleDeliveryModelChange = useCallback(
    (nextModel: StandupDeliveryModel) => {
      setFormData((prev) => ({
        ...prev,
        deliveryModel: nextModel,
        policy: {
          ...prev.policy,
          enableTargetDateChecks: nextModel === 'milestone',
          wipLimitPerPerson: nextModel === 'flow' ? 3 : null,
          slaHoursHighPriority: nextModel === 'support' ? 24 : null,
        },
      }));
    },
    [],
  );

  const loadData = useCallback(async () => {
    try {
      const [configsRes, sessionsRes] = await Promise.all([
        fetch('/api/standup/configs', { credentials: 'include' }),
        fetch('/api/standup/sessions', { credentials: 'include' }),
      ]);
      const [configsBody, sessionsBody] = await Promise.all([
        configsRes.json().catch(() => null),
        sessionsRes.json().catch(() => null),
      ]);
      const errors: string[] = [];
      if (!configsRes.ok || !Array.isArray(configsBody)) {
        setConfigs([]);
        errors.push(readStandupError(configsBody, 'standup configurations'));
      } else {
        setConfigs(configsBody);
      }
      if (!sessionsRes.ok || !Array.isArray(sessionsBody)) {
        setSessions([]);
        errors.push(readStandupError(sessionsBody, 'standup sessions'));
      } else {
        setSessions(sessionsBody);
      }
      setLoadError(errors.length > 0 ? errors.join(' ') : null);
    } catch (err) {
      console.error('Failed to load standup data:', err);
      setConfigs([]);
      setSessions([]);
      setLoadError('Failed to load standup data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleSave = useCallback(async () => {
    const method = editId ? 'PUT' : 'POST';
    const url = editId
      ? `/api/standup/configs/${editId}`
      : '/api/standup/configs';
    await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...formData,
        teamGoal: formData.teamGoal.trim() || null,
      }),
    });
    setShowForm(false);
    setEditId(null);
    void loadData();
  }, [editId, formData, loadData]);

  const confirmDeleteConfig = useCallback(async () => {
    if (!pendingDeleteConfig) return;
    setIsDeletingConfig(true);
    try {
      const res = await fetch(
        `/api/standup/configs/${pendingDeleteConfig.id}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok) {
        const data = await res.json();
        alert(data.error ?? 'Failed to delete configuration');
        return;
      }
      setPendingDeleteConfig(null);
      void loadData();
    } finally {
      setIsDeletingConfig(false);
    }
  }, [pendingDeleteConfig, loadData]);

  const handleEdit = useCallback((config: StandupConfig) => {
    const resolvedGroupIds =
      Array.isArray(config.groupIds) && config.groupIds.length > 0
        ? config.groupIds
        : config.groupId
        ? [config.groupId]
        : [];
    const deliveryModel = config.deliveryModel ?? 'flow';
    setFormData({
      groupIds: resolvedGroupIds,
      project: config.project,
      areaPath: config.areaPath ?? '',
      scheduleTime: config.scheduleTime,
      timezone: config.timezone,
      weekdays: config.weekdays,
      enabled: config.enabled,
      deliveryModel,
      goalSource: config.goalSource ?? 'none',
      teamGoal: config.teamGoal ?? '',
      rosterMode: config.rosterMode ?? 'ado_and_groups',
      policy: resolveStandupPolicy(deliveryModel, config.policy),
      reminderDelayMin: config.reminderDelayMin ?? 30,
      reminderIntervalMin: config.reminderIntervalMin ?? 60,
      facilitatorDeadlineMin: config.facilitatorDeadlineMin ?? 120,
    });
    setEditId(config.id);
    setShowForm(true);
  }, []);

  const handleFacilitate = useCallback(
    async (sessionId: string) => {
      await fetch(`/api/standup/sessions/${sessionId}/facilitate`, {
        method: 'POST',
        credentials: 'include',
      });
      void loadData();
    },
    [loadData],
  );

  const confirmDeleteSession = useCallback(async () => {
    if (!pendingDeleteSession) return;
    setIsDeletingSession(true);
    try {
      const res = await fetch(
        `/api/standup/sessions/${pendingDeleteSession.id}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok) {
        const data = await res.json();
        alert(data.error ?? 'Failed to delete session');
        return;
      }
      setPendingDeleteSession(null);
      void loadData();
    } finally {
      setIsDeletingSession(false);
    }
  }, [pendingDeleteSession, loadData]);

  const handleTrigger = useCallback(
    async (configId: string) => {
      const res = await fetch(`/api/standup/configs/${configId}/trigger`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? 'Failed to trigger standup');
        return;
      }
      if (data.alreadyExisted) {
        alert(
          'A standup session for today already exists. Head to the Standup tab to participate.',
        );
      }
      void loadData();
    },
    [loadData],
  );

  const toggleWeekday = useCallback((day: number) => {
    setFormData((prev) => ({
      ...prev,
      weekdays: prev.weekdays.includes(day)
        ? prev.weekdays.filter((d) => d !== day)
        : [...prev.weekdays, day].sort(),
    }));
  }, []);

  const handleNewConfig = useCallback(() => {
    setFormData(makeDefaultFormState(selectedProject || ''));
    setEditId(null);
    setShowForm(true);
  }, [selectedProject]);

  if (loading) {
    return (
      <div className={styles.container}>
        <StandupSubNav />
        <p className={styles.loadingText}>Loading...</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <StandupSubNav />
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1>Standup Management</h1>
            <div
              className={styles.infoIcon}
              onClick={() => setShowManageInfo(!showManageInfo)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setShowManageInfo(!showManageInfo);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label="Show information about standup management"
              aria-expanded={showManageInfo}
              data-testid="standup-manage-info-btn"
            >
              <InfoIcon />
            </div>
          </div>
          <button
            type="button"
            className={styles.addBtn}
            onClick={handleNewConfig}
            {...{ 'data-testid': 'standup-new-config-btn' }}
          >
            + New Config
          </button>
        </header>

        {loadError && (
          <p className={styles.loadError} data-testid="standup-manage-load-error" role="alert">
            {loadError}
          </p>
        )}

        {showManageInfo && (
          <div className={styles.infoTooltip}>
            <button
              type="button"
              className={styles.infoClose}
              onClick={() => setShowManageInfo(false)}
              aria-label="Close information"
              data-testid="standup-manage-info-close-btn"
            >
              ×
            </button>
            <p>
              <strong>What this page does:</strong>
              <br />
              Configure automated daily standups, hybrid ADO contributor
              discovery, and SDLC-aware Delivery Pulse policies. Choose how
              participants are discovered (ADO Work Items + Groups, Active ADO
              Assignees Only, or Selected Groups Only) and select a Delivery
              Model (Flow, Sprint, Milestone, Support, or Custom).
            </p>
          </div>
        )}

        {showForm && (
          <div className={styles.form} {...{ 'data-testid': 'standup-config-form' }}>
            <h3>{editId ? 'Edit Configuration' : 'New Configuration'}</h3>
            <div className={styles.formGrid}>
              <label htmlFor="standup-config-project">
                Project
                <select
                  id="standup-config-project"
                  value={formData.project}
                  onChange={(e) =>
                    setFormData((p) => ({
                      ...p,
                      project: e.target.value,
                      groupIds: [],
                      areaPath: '',
                    }))
                  }
                  className={styles.select}
                  {...{ 'data-testid': 'standup-config-project' }}
                >
                  <option value="">— Select project —</option>
                  {asList(adoProjects).map((p) => (
                    <option key={p.id} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label htmlFor="standup-config-roster-mode">
                Participant Discovery
                <select
                  id="standup-config-roster-mode"
                  value={formData.rosterMode}
                  onChange={(e) =>
                    setFormData((p) => ({
                      ...p,
                      rosterMode: e.target.value as StandupRosterMode,
                    }))
                  }
                  className={styles.select}
                  data-testid="standup-config-roster-mode"
                >
                  {ROSTER_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label htmlFor="standup-config-delivery-model">
                Delivery Model
                <select
                  id="standup-config-delivery-model"
                  value={formData.deliveryModel}
                  onChange={(e) =>
                    handleDeliveryModelChange(
                      e.target.value as StandupDeliveryModel,
                    )
                  }
                  className={styles.select}
                  {...{ 'data-testid': 'standup-config-delivery-model' }}
                >
                  {DELIVERY_MODEL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label htmlFor="standup-config-goal-source">
                Goal Source
                <select
                  id="standup-config-goal-source"
                  value={formData.goalSource}
                  onChange={(e) =>
                    setFormData((p) => ({
                      ...p,
                      goalSource: e.target.value as StandupGoalSource,
                    }))
                  }
                  className={styles.select}
                  {...{ 'data-testid': 'standup-config-goal-source' }}
                >
                  {GOAL_SOURCE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <label
                htmlFor="standup-config-team-goal"
                className={styles.fullSpanField}
              >
                Team Goal
                <input
                  id="standup-config-team-goal"
                  type="text"
                  value={formData.teamGoal}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, teamGoal: e.target.value }))
                  }
                  placeholder="e.g., Keep flow cycle time < 3 days & ship auth API"
                  {...{ 'data-testid': 'standup-config-team-goal' }}
                />
              </label>

              <div className={styles.groupPickerWrapper}>
                <span className={styles.groupPickerLabel}>
                  Groups{' '}
                  {formData.rosterMode === 'groups_only'
                    ? '(required)'
                    : '(optional — combined with or filters ADO contributors)'}
                  {formData.groupIds.length > 0 && (
                    <span className={styles.groupCount}>
                      {formData.groupIds.length} selected
                    </span>
                  )}
                </span>
                {!formData.project ? (
                  <p className={styles.groupPickerHint}>Select a project first</p>
                ) : groupsLoading ? (
                  <p className={styles.groupPickerHint}>Loading groups…</p>
                ) : asList(groups).length === 0 ? (
                  <p className={styles.groupPickerHint}>
                    No groups found for this project — active ADO contributors
                    will still be discovered automatically unless Selected Groups
                    Only is chosen.
                  </p>
                ) : (
                  <div className={styles.groupCheckList}>
                    {asList(groups).map((g) => (
                      <label
                        key={g.id}
                        className={styles.groupCheckItem}
                        htmlFor={`standup-group-${g.id}`}
                      >
                        <input
                          id={`standup-group-${g.id}`}
                          type="checkbox"
                          checked={formData.groupIds.includes(g.id)}
                          onChange={() => toggleGroup(g.id)}
                          {...{ 'data-testid': `standup-group-checkbox-${g.id}` }}
                        />
                        {g.name}
                      </label>
                    ))}
                  </div>
                )}

                {rosterPreview && (
                  <div
                    className={styles.rosterPreviewBar}
                    data-testid="standup-roster-preview"
                  >
                    <strong>Resolved Roster Preview:</strong>{' '}
                    {asList(rosterPreview.participants).length} participant(s)
                    {asList(rosterPreview.participants).length > 0 && (
                      <span>
                        {' — '}
                        {asList(rosterPreview.participants)
                          .slice(0, 6)
                          .map(
                            (p) =>
                              `${p.displayName ?? p.email ?? p.userId} (${p.source})`,
                          )
                          .join(', ')}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <label htmlFor="standup-config-area-path">
                Area Path
                <select
                  id="standup-config-area-path"
                  value={formData.areaPath}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, areaPath: e.target.value }))
                  }
                  disabled={!formData.project || areaPathsLoading}
                  className={styles.select}
                  data-testid="standup-config-area-path"
                >
                  <option value="">
                    {areaPathsLoading
                      ? 'Loading area paths…'
                      : '— All areas (optional) —'}
                  </option>
                  {asList(areaPaths).map((ap) => (
                    <option key={ap} value={ap}>
                      {ap}
                    </option>
                  ))}
                </select>
              </label>

              <label htmlFor="standup-config-timezone">
                Timezone
                <select
                  id="standup-config-timezone"
                  value={formData.timezone}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, timezone: e.target.value }))
                  }
                  className={styles.select}
                  data-testid="standup-config-timezone"
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className={styles.timingSection}>
              <span className={styles.timingSectionLabel}>
                Delivery Policy &amp; Signals
              </span>
              <div className={styles.policyGrid}>
                <div className={styles.policyStepperCard}>
                  <span className={styles.timingCardLabel}>
                    Stale threshold (days)
                  </span>
                  <NumberStepper
                    value={formData.policy.staleDaysThreshold}
                    min={1}
                    max={30}
                    unit="days"
                    aria-label="Stale threshold days"
                    data-testid="standup-policy-stale-days"
                    onChange={(staleDaysThreshold) =>
                      setFormData((p) => ({
                        ...p,
                        policy: { ...p.policy, staleDaysThreshold },
                      }))
                    }
                  />
                </div>

                <div className={styles.policyStepperCard}>
                  <span className={styles.timingCardLabel}>
                    PR review wait (hours)
                  </span>
                  <NumberStepper
                    value={formData.policy.prReviewWaitHours}
                    min={2}
                    max={168}
                    step={2}
                    unit="hrs"
                    aria-label="PR review wait hours"
                    data-testid="standup-policy-pr-wait-hours"
                    onChange={(prReviewWaitHours) =>
                      setFormData((p) => ({
                        ...p,
                        policy: { ...p.policy, prReviewWaitHours },
                      }))
                    }
                  />
                </div>
              </div>

              <div className={styles.policyToggleRow}>
                <label
                  className={styles.groupCheckItem}
                  htmlFor="policy-pr-evidence"
                >
                  <input
                    id="policy-pr-evidence"
                    type="checkbox"
                    checked={formData.policy.enablePrEvidence}
                    onChange={(e) =>
                      setFormData((p) => ({
                        ...p,
                        policy: {
                          ...p.policy,
                          enablePrEvidence: e.target.checked,
                        },
                      }))
                    }
                    {...{ 'data-testid': 'standup-policy-pr-evidence' }}
                  />
                  PR merge &amp; review evidence
                </label>

                <label
                  className={styles.groupCheckItem}
                  htmlFor="policy-pipeline-evidence"
                >
                  <input
                    id="policy-pipeline-evidence"
                    type="checkbox"
                    checked={formData.policy.enablePipelineEvidence}
                    onChange={(e) =>
                      setFormData((p) => ({
                        ...p,
                        policy: {
                          ...p.policy,
                          enablePipelineEvidence: e.target.checked,
                        },
                      }))
                    }
                    {...{ 'data-testid': 'standup-policy-pipeline-evidence' }}
                  />
                  Pipeline &amp; IaC stage signals
                </label>

                <label
                  className={styles.groupCheckItem}
                  htmlFor="policy-commitment-memory"
                >
                  <input
                    id="policy-commitment-memory"
                    type="checkbox"
                    checked={formData.policy.enableCommitmentMemory}
                    onChange={(e) =>
                      setFormData((p) => ({
                        ...p,
                        policy: {
                          ...p.policy,
                          enableCommitmentMemory: e.target.checked,
                        },
                      }))
                    }
                    {...{ 'data-testid': 'standup-policy-commitment-memory' }}
                  />
                  Multi-day carryover memory
                </label>

                <label
                  className={styles.groupCheckItem}
                  htmlFor="policy-target-date-checks"
                >
                  <input
                    id="policy-target-date-checks"
                    type="checkbox"
                    checked={formData.policy.enableTargetDateChecks}
                    onChange={(e) =>
                      setFormData((p) => ({
                        ...p,
                        policy: {
                          ...p.policy,
                          enableTargetDateChecks: e.target.checked,
                        },
                      }))
                    }
                    {...{ 'data-testid': 'standup-policy-target-date-checks' }}
                  />
                  Require &amp; audit target dates
                </label>
              </div>
            </div>

            <div className={styles.timingSection}>
              <span className={styles.timingSectionLabel}>
                Schedule &amp; timing
              </span>
              <div className={styles.timingGrid}>
                <ScheduleTimeControl
                  value={formData.scheduleTime}
                  onChange={(scheduleTime) =>
                    setFormData((p) => ({ ...p, scheduleTime }))
                  }
                  data-testid="standup-config-schedule-time"
                />
                <DurationControl
                  label="First reminder after"
                  hint="How long after the session starts before the first reminder"
                  value={formData.reminderDelayMin}
                  min={5}
                  presets={[15, 30, 45, 60]}
                  onChange={(reminderDelayMin) =>
                    setFormData((p) => ({ ...p, reminderDelayMin }))
                  }
                  data-testid="standup-config-reminder-delay"
                />
                <DurationControl
                  label="Remind every"
                  hint="How often to re-send reminders to pending participants"
                  value={formData.reminderIntervalMin}
                  min={5}
                  presets={[30, 60, 90, 120]}
                  onChange={(reminderIntervalMin) =>
                    setFormData((p) => ({ ...p, reminderIntervalMin }))
                  }
                  data-testid="standup-config-reminder-interval"
                />
                <DurationControl
                  label="Facilitator deadline"
                  hint="Auto-trigger the facilitator after this duration"
                  value={formData.facilitatorDeadlineMin}
                  min={15}
                  presets={[60, 90, 120, 180]}
                  onChange={(facilitatorDeadlineMin) =>
                    setFormData((p) => ({ ...p, facilitatorDeadlineMin }))
                  }
                  data-testid="standup-config-facilitator-deadline"
                />
              </div>
            </div>

            <div className={styles.weekdays}>
              {WEEKDAY_LABELS.map((label, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`${styles.weekdayBtn} ${
                    formData.weekdays.includes(idx) ? styles.active : ''
                  }`}
                  onClick={() => toggleWeekday(idx)}
                  data-testid={`standup-config-weekday-${idx}`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.saveBtn}
                onClick={() => {
                  void handleSave();
                }}
                {...{ 'data-testid': 'standup-config-save-btn' }}
              >
                Save
              </button>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => setShowForm(false)}
                data-testid="standup-config-cancel-btn"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <section className={styles.section}>
          <h2>Configurations</h2>
          {configs.length === 0 ? (
            <p className={styles.muted}>No standup configurations yet.</p>
          ) : (
            <div className={styles.configList}>
              {configs.map((config) => {
                const modelKey = config.deliveryModel ?? 'flow';
                const modelLabel =
                  STANDUP_DELIVERY_MODEL_LABELS[modelKey] ?? 'Flow';
                const rosterKey = config.rosterMode ?? 'ado_and_groups';
                const rosterLabel =
                  STANDUP_ROSTER_MODE_SHORT_LABELS[rosterKey] ?? 'ADO + Groups';
                return (
                  <div
                    key={config.id}
                    className={styles.configCard}
                    {...{ 'data-testid': `standup-config-card-${config.id}` }}
                  >
                    <div className={styles.configHeader}>
                      <div className={styles.configGroups}>
                        {(asList(config.groups).length > 0
                          ? asList(config.groups).map((g) => g.name)
                          : config.group
                          ? [config.group.name]
                          : ['(ADO auto-discovered)']
                        ).map((name) => (
                          <span key={name} className={styles.groupTag}>
                            {name}
                          </span>
                        ))}
                      </div>
                      <span className={styles.project}>{config.project}</span>
                      <span
                        className={styles.modelPill}
                        {...{
                          'data-testid': `standup-config-card-model-${config.id}`,
                        }}
                      >
                        {modelLabel}
                      </span>
                      <span
                        className={styles.rosterPill}
                        data-testid={`standup-config-card-roster-${config.id}`}
                      >
                        {rosterLabel}
                      </span>
                      {!config.enabled && (
                        <span className={styles.disabled}>Disabled</span>
                      )}
                    </div>
                    {config.teamGoal && (
                      <div
                        className={styles.configGoal}
                        {...{
                          'data-testid': `standup-config-card-goal-${config.id}`,
                        }}
                      >
                        <strong>Team Goal:</strong> {config.teamGoal}
                      </div>
                    )}
                    <div className={styles.configMeta}>
                      <span>
                        {config.scheduleTime} {config.timezone}
                      </span>
                      <span>
                        {asList<number>(config.weekdays)
                          .map((d) => WEEKDAY_LABELS[d])
                          .join(', ')}
                      </span>
                    </div>
                    <div className={styles.configMeta}>
                      <span>
                        Remind after {config.reminderDelayMin ?? 30} min, every{' '}
                        {config.reminderIntervalMin ?? 60} min {' · '}
                        Facilitator at {config.facilitatorDeadlineMin ?? 120} min
                      </span>
                    </div>
                    <div className={styles.configActions}>
                      <button
                        type="button"
                        onClick={() => {
                          void handleTrigger(config.id);
                        }}
                        data-testid={`standup-config-trigger-${config.id}`}
                      >
                        Run Now
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEdit(config)}
                        {...{
                          'data-testid': `standup-config-edit-${config.id}`,
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPendingDeleteConfig({
                            id: config.id,
                            label: config.project,
                          })
                        }
                        data-testid={`standup-config-delete-${config.id}`}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className={styles.section}>
          <h2>Recent Sessions</h2>
          {sessions.length === 0 ? (
            <p className={styles.muted}>No sessions yet.</p>
          ) : (
            <div className={styles.sessionList}>
              {sessions.map((session) => (
                <div key={session.id} className={styles.sessionCard}>
                  <div className={styles.sessionHeader}>
                    <span className={styles.sessionDate}>
                      {session.sessionDate}
                    </span>
                    <span
                      className={`${styles.status} ${styles[session.status] ?? ''}`}
                    >
                      {session.status}
                    </span>
                  </div>
                  <div className={styles.participants}>
                    {asList(session.participants).map((p) => (
                      <span
                        key={p.id}
                        className={`${styles.participantChip} ${styles[p.status] ?? ''}`}
                      >
                        {p.status}
                      </span>
                    ))}
                  </div>
                  <div className={styles.sessionActions}>
                    {session.status === 'collecting' && (
                      <button
                        type="button"
                        className={styles.facilitateBtn}
                        onClick={() => {
                          void handleFacilitate(session.id);
                        }}
                        data-testid={`standup-session-facilitate-${session.id}`}
                      >
                        Trigger Facilitator
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.deleteSessionBtn}
                      onClick={() =>
                        setPendingDeleteSession({
                          id: session.id,
                          sessionDate: session.sessionDate,
                        })
                      }
                      data-testid={`standup-session-delete-${session.id}`}
                    >
                      Delete Session
                    </button>
                  </div>
                  {asList(session.followups).length > 0 && (
                    <div className={styles.followups}>
                      {asList(session.followups).map((f) => (
                        <div key={f.id} className={styles.followupItem}>
                          {f.title}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {pendingDeleteSession && (
        // data-testid-exempt — ConfirmDeleteModal owns its modal testids
        <ConfirmDeleteModal
          title="Delete Standup Session"
          itemName={pendingDeleteSession.sessionDate}
          description="All participant threads and facilitator data will be removed. You can start a fresh session with Run Now. Are you sure you want to delete the session for"
          isPending={isDeletingSession}
          onConfirm={confirmDeleteSession}
          onCancel={() => !isDeletingSession && setPendingDeleteSession(null)}
        />
      )}

      {pendingDeleteConfig && (
        // data-testid-exempt — ConfirmDeleteModal owns its modal testids
        <ConfirmDeleteModal
          title="Delete Standup Configuration"
          itemName={pendingDeleteConfig.label}
          description="Are you sure you want to delete the standup configuration for"
          isPending={isDeletingConfig}
          onConfirm={confirmDeleteConfig}
          onCancel={() => !isDeletingConfig && setPendingDeleteConfig(null)}
        />
      )}
    </div>
  );
};

export default StandupManageView;
