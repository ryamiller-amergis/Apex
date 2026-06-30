import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useGroups } from '../hooks/useGroups';
import { useProjects, useProjectAreaPaths } from '../hooks/useProjects';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import {
  formatDurationLabel,
  minuteOptionsForValue,
  parseScheduleTime,
  toScheduleTime,
} from '../utils/standupTiming';
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
}

const ScheduleTimeControl: React.FC<ScheduleTimeControlProps> = ({ value, onChange }) => {
  const { hour12, minute, period } = parseScheduleTime(value);
  const minuteOptions = minuteOptionsForValue(minute);

  const update = (next: Partial<{ hour12: number; minute: number; period: 'AM' | 'PM' }>) => {
    onChange(toScheduleTime(
      next.hour12 ?? hour12,
      next.minute ?? minute,
      next.period ?? period,
    ));
  };

  return (
    <div className={styles.timingCard}>
      <span className={styles.timingCardLabel}>Schedule time</span>
      <div className={styles.timeControl}>
        <select
          className={styles.timeSelect}
          value={hour12}
          onChange={(e) => update({ hour12: Number(e.target.value) })}
          aria-label="Hour"
        >
          {HOUR_OPTIONS.map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </select>
        <span className={styles.timeSeparator}>:</span>
        <select
          className={styles.timeSelect}
          value={minute}
          onChange={(e) => update({ minute: Number(e.target.value) })}
          aria-label="Minute"
        >
          {minuteOptions.map((m) => (
            <option key={m} value={m}>{String(m).padStart(2, '0')}</option>
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
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <span className={styles.fieldHint}>When the standup session starts on scheduled days</span>
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
}) => {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  return (
    <div className={styles.timingCard}>
      <span className={styles.timingCardLabel}>{label}</span>
      <div className={styles.durationStepper}>
        <button
          type="button"
          className={styles.stepperBtn}
          onClick={() => onChange(clamp(value - step))}
          disabled={value <= min}
          aria-label={`Decrease ${label}`}
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
        >
          +
        </button>
      </div>
      <div className={styles.presetChips} role="group" aria-label={`${label} presets`}>
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`${styles.presetChip} ${value === preset ? styles.presetChipActive : ''}`}
            onClick={() => onChange(preset)}
            aria-pressed={value === preset}
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
      <button className={styles.subNavBtn} onClick={() => navigate('/standup')}>My Standup</button>
      {can('standup:participate') && (
        <button className={styles.subNavBtn} onClick={() => navigate('/standup-summary')}>Summary</button>
      )}
      <button className={`${styles.subNavBtn} ${styles.subNavActive}`} onClick={() => navigate('/standup-manage')}>Manage</button>
    </div>
  );
};

export const StandupManageView: React.FC = () => {
  const { selectedProject } = useAppShell();
  const { data: adoProjects = [] } = useProjects();

  const [configs, setConfigs] = useState<StandupConfig[]>([]);
  const [sessions, setSessions] = useState<StandupSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; sessionDate: string } | null>(null);
  const [pendingDeleteConfig, setPendingDeleteConfig] = useState<{ id: string; label: string } | null>(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [isDeletingConfig, setIsDeletingConfig] = useState(false);
  const [showManageInfo, setShowManageInfo] = useState(false);

  const [formData, setFormData] = useState({
    groupIds: [] as string[],
    project: selectedProject || '',
    areaPath: '',
    scheduleTime: '09:00',
    timezone: 'America/New_York',
    weekdays: [1, 2, 3, 4, 5] as number[],
    enabled: true,
    reminderDelayMin: 30,
    reminderIntervalMin: 60,
    facilitatorDeadlineMin: 120,
  });

  const { data: groups = [], isLoading: groupsLoading } = useGroups(formData.project || undefined);
  const { data: areaPaths = [], isLoading: areaPathsLoading } = useProjectAreaPaths(formData.project || null);

  const toggleGroup = useCallback((groupId: string) => {
    setFormData((prev) => ({
      ...prev,
      groupIds: prev.groupIds.includes(groupId)
        ? prev.groupIds.filter((id) => id !== groupId)
        : [...prev.groupIds, groupId],
    }));
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [configsRes, sessionsRes] = await Promise.all([
        fetch('/api/standup/configs'),
        fetch('/api/standup/sessions'),
      ]);
      setConfigs(await configsRes.json());
      setSessions(await sessionsRes.json());
    } catch (err) {
      console.error('Failed to load standup data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSave = useCallback(async () => {
    const method = editId ? 'PUT' : 'POST';
    const url = editId ? `/api/standup/configs/${editId}` : '/api/standup/configs';
    await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });
    setShowForm(false);
    setEditId(null);
    loadData();
  }, [editId, formData, loadData]);

  const confirmDeleteConfig = useCallback(async () => {
    if (!pendingDeleteConfig) return;
    setIsDeletingConfig(true);
    try {
      const res = await fetch(`/api/standup/configs/${pendingDeleteConfig.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error ?? 'Failed to delete configuration');
        return;
      }
      setPendingDeleteConfig(null);
      loadData();
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
    setFormData({
      groupIds: resolvedGroupIds,
      project: config.project,
      areaPath: config.areaPath ?? '',
      scheduleTime: config.scheduleTime,
      timezone: config.timezone,
      weekdays: config.weekdays,
      enabled: config.enabled,
      reminderDelayMin: config.reminderDelayMin ?? 30,
      reminderIntervalMin: config.reminderIntervalMin ?? 60,
      facilitatorDeadlineMin: config.facilitatorDeadlineMin ?? 120,
    });
    setEditId(config.id);
    setShowForm(true);
  }, []);

  const handleFacilitate = useCallback(async (sessionId: string) => {
    await fetch(`/api/standup/sessions/${sessionId}/facilitate`, { method: 'POST' });
    loadData();
  }, [loadData]);

  const confirmDeleteSession = useCallback(async () => {
    if (!pendingDeleteSession) return;
    setIsDeletingSession(true);
    try {
      const res = await fetch(`/api/standup/sessions/${pendingDeleteSession.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error ?? 'Failed to delete session');
        return;
      }
      setPendingDeleteSession(null);
      loadData();
    } finally {
      setIsDeletingSession(false);
    }
  }, [pendingDeleteSession, loadData]);

  const handleTrigger = useCallback(async (configId: string) => {
    const res = await fetch(`/api/standup/configs/${configId}/trigger`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error ?? 'Failed to trigger standup');
      return;
    }
    if (data.alreadyExisted) {
      alert("A standup session for today already exists. Head to the Standup tab to participate.");
    }
    loadData();
  }, [loadData]);

  const toggleWeekday = useCallback((day: number) => {
    setFormData((prev) => ({
      ...prev,
      weekdays: prev.weekdays.includes(day)
        ? prev.weekdays.filter((d) => d !== day)
        : [...prev.weekdays, day].sort(),
    }));
  }, []);

  const handleNewConfig = useCallback(() => {
    setFormData({
      groupIds: [],
      project: selectedProject || '',
      areaPath: '',
      scheduleTime: '09:00',
      timezone: 'America/New_York',
      weekdays: [1, 2, 3, 4, 5],
      enabled: true,
      reminderDelayMin: 30,
      reminderIntervalMin: 60,
      facilitatorDeadlineMin: 120,
    });
    setEditId(null);
    setShowForm(true);
  }, [selectedProject]);

  if (loading) return <div className={styles.container}><StandupSubNav /><p>Loading...</p></div>;

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
          >
            <InfoIcon />
          </div>
        </div>
        <button className={styles.addBtn} onClick={handleNewConfig}>
          + New Config
        </button>
      </header>

      {showManageInfo && (
        <div className={styles.infoTooltip}>
          <button
            type="button"
            className={styles.infoClose}
            onClick={() => setShowManageInfo(false)}
            aria-label="Close information"
          >
            ×
          </button>
          <p>
            <strong>What this page does:</strong>
            <br />
            Configure automated daily standups for ADO project groups. Each enabled configuration
            creates a session on its scheduled weekdays, notifies members, and guides them through
            yesterday / today / blockers updates via a standup agent.
          </p>
          <p>
            <strong>Configurations:</strong>
            <br />
            Tie a config to a project, one or more groups, optional area path, and a schedule
            (time, timezone, weekdays). <strong>Run Now</strong> immediately starts today&apos;s session
            for that config — creating participant chat threads and sending notifications — without
            waiting for the next scheduled run.
          </p>
          <p>
            <strong>Session lifecycle:</strong>
            <br />
            <span className={styles.statusLabel}>collecting</span> — participants submit updates.{' '}
            <span className={styles.statusLabel}>facilitating</span> — a facilitator agent reads all
            submissions, identifies cross-cutting themes, and creates follow-ups.{' '}
            <span className={styles.statusLabel}>completed</span> — the summary is saved and members
            are notified of any follow-up discussions.
          </p>
          <p>
            <strong>Trigger Facilitator:</strong>
            <br />
            Ends the collecting phase early and starts the facilitator agent for a session still in{' '}
            <span className={styles.statusLabel}>collecting</span> status. Normally the facilitator runs
            automatically when every participant has submitted, or after the configurable &ldquo;Facilitator
            deadline&rdquo; (default 120 minutes). Use this button when you want to wrap up before
            everyone has submitted.
          </p>
          <p>
            <strong>Reminders:</strong>
            <br />
            Participants who haven&apos;t submitted receive periodic reminders. The &ldquo;First reminder
            after&rdquo; setting controls when the first reminder goes out (default 30 minutes).
            &ldquo;Remind every&rdquo; controls how often subsequent reminders are sent (default 60
            minutes). These are configurable per standup configuration.
          </p>
          <p>
            <strong>Delete Session:</strong>
            <br />
            Removes a session and its participant data so you can start fresh with Run Now on the
            configuration.
          </p>
        </div>
      )}

      {showForm && (
        <div className={styles.form}>
          <h3>{editId ? 'Edit Configuration' : 'New Configuration'}</h3>
          <div className={styles.formGrid}>
            <label>
              Project
              <select
                value={formData.project}
                onChange={(e) => setFormData((p) => ({ ...p, project: e.target.value, groupIds: [], areaPath: '' }))}
                className={styles.select}
              >
                <option value="">— Select project —</option>
                {adoProjects.map((p) => (
                  <option key={p.id} value={p.name}>{p.name}</option>
                ))}
              </select>
            </label>
            <div className={styles.groupPickerWrapper}>
              <span className={styles.groupPickerLabel}>
                Groups
                {formData.groupIds.length > 0 && (
                  <span className={styles.groupCount}>{formData.groupIds.length} selected</span>
                )}
              </span>
              {!formData.project ? (
                <p className={styles.groupPickerHint}>Select a project first</p>
              ) : groupsLoading ? (
                <p className={styles.groupPickerHint}>Loading groups…</p>
              ) : groups.length === 0 ? (
                <p className={styles.groupPickerHint}>No groups found for this project</p>
              ) : (
                <div className={styles.groupCheckList}>
                  {groups.map((g) => (
                    <label key={g.id} className={styles.groupCheckItem}>
                      <input
                        type="checkbox"
                        checked={formData.groupIds.includes(g.id)}
                        onChange={() => toggleGroup(g.id)}
                      />
                      {g.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label>
              Area Path
              <select
                value={formData.areaPath}
                onChange={(e) => setFormData((p) => ({ ...p, areaPath: e.target.value }))}
                disabled={!formData.project || areaPathsLoading}
                className={styles.select}
              >
                <option value="">
                  {areaPathsLoading ? 'Loading area paths…' : '— All areas (optional) —'}
                </option>
                {areaPaths.map((ap) => (
                  <option key={ap} value={ap}>{ap}</option>
                ))}
              </select>
            </label>
            <label>
              Timezone
              <select
                value={formData.timezone}
                onChange={(e) => setFormData((p) => ({ ...p, timezone: e.target.value }))}
                className={styles.select}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </label>
          </div>
          <div className={styles.timingSection}>
            <span className={styles.timingSectionLabel}>Schedule &amp; timing</span>
            <div className={styles.timingGrid}>
              <ScheduleTimeControl
                value={formData.scheduleTime}
                onChange={(scheduleTime) => setFormData((p) => ({ ...p, scheduleTime }))}
              />
              <DurationControl
                label="First reminder after"
                hint="How long after the session starts before the first reminder"
                value={formData.reminderDelayMin}
                min={5}
                presets={[15, 30, 45, 60]}
                onChange={(reminderDelayMin) => setFormData((p) => ({ ...p, reminderDelayMin }))}
              />
              <DurationControl
                label="Remind every"
                hint="How often to re-send reminders to pending participants"
                value={formData.reminderIntervalMin}
                min={5}
                presets={[30, 60, 90, 120]}
                onChange={(reminderIntervalMin) => setFormData((p) => ({ ...p, reminderIntervalMin }))}
              />
              <DurationControl
                label="Facilitator deadline"
                hint="Auto-trigger the facilitator after this duration"
                value={formData.facilitatorDeadlineMin}
                min={15}
                presets={[60, 90, 120, 180]}
                onChange={(facilitatorDeadlineMin) => setFormData((p) => ({ ...p, facilitatorDeadlineMin }))}
              />
            </div>
          </div>
          <div className={styles.weekdays}>
            {WEEKDAY_LABELS.map((label, idx) => (
              <button
                key={idx}
                className={`${styles.weekdayBtn} ${formData.weekdays.includes(idx) ? styles.active : ''}`}
                onClick={() => toggleWeekday(idx)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={styles.formActions}>
            <button className={styles.saveBtn} onClick={handleSave}>Save</button>
            <button className={styles.cancelBtn} onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <section className={styles.section}>
        <h2>Configurations</h2>
        {configs.length === 0 ? (
          <p className={styles.muted}>No standup configurations yet.</p>
        ) : (
          <div className={styles.configList}>
            {configs.map((config) => (
              <div key={config.id} className={styles.configCard}>
                <div className={styles.configHeader}>
                  <div className={styles.configGroups}>
                    {(config.groups && config.groups.length > 0
                      ? config.groups.map((g) => g.name)
                      : config.group
                      ? [config.group.name]
                      : ['(no groups)']
                    ).map((name) => (
                      <span key={name} className={styles.groupTag}>{name}</span>
                    ))}
                  </div>
                  <span className={styles.project}>{config.project}</span>
                  {!config.enabled && <span className={styles.disabled}>Disabled</span>}
                </div>
                <div className={styles.configMeta}>
                  <span>{config.scheduleTime} {config.timezone}</span>
                  <span>{config.weekdays.map((d) => WEEKDAY_LABELS[d]).join(', ')}</span>
                </div>
                <div className={styles.configMeta}>
                  <span>
                    Remind after {config.reminderDelayMin ?? 30} min, every {config.reminderIntervalMin ?? 60} min
                    {' · '}Facilitator at {config.facilitatorDeadlineMin ?? 120} min
                  </span>
                </div>
                <div className={styles.configActions}>
                  <button onClick={() => handleTrigger(config.id)}>Run Now</button>
                  <button onClick={() => handleEdit(config)}>Edit</button>
                  <button onClick={() => setPendingDeleteConfig({ id: config.id, label: config.project })}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
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
                  <span className={styles.sessionDate}>{session.sessionDate}</span>
                  <span className={`${styles.status} ${styles[session.status]}`}>
                    {session.status}
                  </span>
                </div>
                <div className={styles.participants}>
                  {session.participants.map((p) => (
                    <span key={p.id} className={`${styles.participantChip} ${styles[p.status]}`}>
                      {p.status}
                    </span>
                  ))}
                </div>
                <div className={styles.sessionActions}>
                  {session.status === 'collecting' && (
                    <button className={styles.facilitateBtn} onClick={() => handleFacilitate(session.id)}>
                      Trigger Facilitator
                    </button>
                  )}
                  <button
                    className={styles.deleteSessionBtn}
                    onClick={() => setPendingDeleteSession({ id: session.id, sessionDate: session.sessionDate })}
                  >
                    Delete Session
                  </button>
                </div>
                {session.followups.length > 0 && (
                  <div className={styles.followups}>
                    {session.followups.map((f) => (
                      <div key={f.id} className={styles.followupItem}>{f.title}</div>
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
