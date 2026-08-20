import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import styles from './StandupSummaryView.module.css';

interface SessionDetail {
  id: string;
  sessionDate: string;
  status: string;
  summaryMarkdown: string | null;
  config: { project: string; areaPath: string | null };
  participants: Array<{
    id: string;
    userId: string;
    displayName?: string | null;
    status: string;
    structuredUpdate: { yesterday?: string; today?: string; blockers?: string; atRisk?: string; handoffs?: string; capacity?: string } | null;
    submittedAt: string | null;
  }>;
  followups: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    participantUserIds: string[];
  }>;
}

function shortUserLabel(userId: string, displayName?: string | null): string {
  if (displayName?.trim()) return displayName.trim();
  if (userId.length <= 12) return userId;
  return `${userId.slice(0, 8)}…`;
}

const StandupSubNav: React.FC = () => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  return (
    <div className={styles.subNav}>
      <button className={styles.subNavBtn} onClick={() => navigate('/standup')} {...{ 'data-testid': 'standup-summary-sub-nav-btn' }}>My Standup</button>
      <button className={`${styles.subNavBtn} ${styles.subNavActive}`} onClick={() => navigate('/standup-summary')} {...{ 'data-testid': 'standup-summary-sub-nav-btn-2' }}>Summary</button>
      {can('standup:manage') && (
        <button className={styles.subNavBtn} onClick={() => navigate('/standup-manage')} {...{ 'data-testid': 'standup-summary-sub-nav-btn-3' }}>Manage</button>
      )}
    </div>
  );
};

export const StandupSummaryView: React.FC = () => {
  const [searchParams] = useSearchParams();
  const id = searchParams.get('session');
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [nameByOid, setNameByOid] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id) {
      setSession(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    fetch(`/api/standup/sessions/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error('Session not found');
        return r.json() as Promise<SessionDetail>;
      })
      .then(async (data) => {
        if (cancelled) return;
        setSession(data);

        const oids = [...new Set(data.participants.map((p) => p.userId).filter(Boolean))];
        const entries = await Promise.all(
          oids.map(async (oid) => {
            try {
              const res = await fetch(`/api/profile/users/${encodeURIComponent(oid)}/card`, {
                credentials: 'include',
              });
              if (!res.ok) return [oid, ''] as const;
              const card = await res.json() as { displayName?: string };
              return [oid, card.displayName?.trim() ?? ''] as const;
            } catch {
              return [oid, ''] as const;
            }
          }),
        );
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const [oid, name] of entries) {
          if (name) map[oid] = name;
        }
        setNameByOid(map);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) {
    return (
      <div className={styles.container}>
        <StandupSubNav />
        <p>Select a standup session</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.container}>
        <StandupSubNav />
        <p>Loading session...</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.container}>
        <StandupSubNav />
        <p>Session not found.</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <StandupSubNav />
      <div className={styles.content}>
        <header className={styles.header}>
          <h1>Standup Summary</h1>
          <span className={styles.date}>{session.sessionDate}</span>
          <span className={`${styles.status} ${styles[session.status]}`}>{session.status}</span>
        </header>

        {session.summaryMarkdown && (
          <section className={styles.section}>
            <h2>Facilitator Summary</h2>
            <div className={styles.markdown}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{session.summaryMarkdown}</ReactMarkdown>
            </div>
          </section>
        )}

        <section className={styles.section}>
          <h2>Participants ({session.participants.length})</h2>
          <div className={styles.participantList}>
            {session.participants.map((p) => (
              <div key={p.id} className={styles.participantCard}>
                <div className={styles.participantHeader}>
                  <span className={styles.userId} title={p.userId}>
                    {shortUserLabel(p.userId, p.displayName ?? nameByOid[p.userId])}
                  </span>
                  <span className={`${styles.chip} ${styles[p.status]}`}>{p.status}</span>
                </div>
                {p.structuredUpdate && (
                  <div className={styles.update}>
                    {p.structuredUpdate.yesterday && (
                      <div><strong>Yesterday:</strong> {p.structuredUpdate.yesterday}</div>
                    )}
                    {p.structuredUpdate.today && (
                      <div><strong>Today:</strong> {p.structuredUpdate.today}</div>
                    )}
                    {p.structuredUpdate.blockers && (
                      <div className={styles.blocker}><strong>Blockers:</strong> {p.structuredUpdate.blockers}</div>
                    )}
                    {p.structuredUpdate.atRisk && (
                      <div className={styles.blocker}><strong>At risk:</strong> {p.structuredUpdate.atRisk}</div>
                    )}
                    {p.structuredUpdate.handoffs && (
                      <div><strong>Handoffs:</strong> {p.structuredUpdate.handoffs}</div>
                    )}
                    {p.structuredUpdate.capacity && (
                      <div><strong>Capacity:</strong> {p.structuredUpdate.capacity}</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {session.followups.length > 0 && (
          <section className={styles.section}>
            <h2>Follow-ups ({session.followups.length})</h2>
            <div className={styles.followupList}>
              {session.followups.map((f) => (
                <div key={f.id} className={styles.followupCard}>
                  <div className={styles.followupTitle}>{f.title}</div>
                  {f.description && <div className={styles.followupDesc}>{f.description}</div>}
                  <div className={styles.followupMeta}>
                    <span className={`${styles.chip} ${styles[f.status]}`}>{f.status}</span>
                    <span>{f.participantUserIds.length} participant(s)</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default StandupSummaryView;
