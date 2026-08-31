import React, { useEffect, useState } from 'react';
import type { DevMockPersonaId } from '../../shared/constants/devMockUsers';
import { IS_BETA_RELEASE } from '../config/release';
import { buildLoginUrl, sanitizeAuthReturnTo } from '../../shared/utils/authReturnTo';
import { BrandLogo } from './BrandLogo';
import styles from './Login.module.css';

interface DevLoginPersona {
  id: DevMockPersonaId;
  label: string;
  displayName: string;
}

function currentReturnTo(): string | null {
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  // The root path is already the default post-login destination.
  if (path === '/' || path === '') return null;
  return sanitizeAuthReturnTo(path);
}

export const Login: React.FC = () => {
  const [checking, setChecking] = useState(true);
  const [devLoginAvailable, setDevLoginAvailable] = useState(false);
  const [devPersonas, setDevPersonas] = useState<DevLoginPersona[]>([]);
  const [devLoggingIn, setDevLoggingIn] = useState<DevMockPersonaId | null>(null);

  useEffect(() => {
    const returnTo = currentReturnTo();
    const checkAuth = fetch('/auth/status', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.authenticated) {
          window.location.href = returnTo || '/';
          return;
        }
        setChecking(false);
      })
      .catch(() => setChecking(false));

    const checkDev = fetch('/auth/dev-login-available', { credentials: 'include' })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.available) {
          setDevLoginAvailable(true);
          if (Array.isArray(data.personas)) {
            setDevPersonas(data.personas);
          }
        }
      })
      .catch(() => {});

    Promise.allSettled([checkAuth, checkDev]);
  }, []);

  const handleLogin = () => {
    window.location.href = buildLoginUrl(currentReturnTo());
  };

  const handleDevLogin = async (persona: DevMockPersonaId) => {
    setDevLoggingIn(persona);
    const returnTo = currentReturnTo();
    try {
      const res = await fetch('/auth/dev-login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(returnTo ? { persona, returnTo } : { persona }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({} as { redirectTo?: string }));
        window.location.href = sanitizeAuthReturnTo(body.redirectTo) || returnTo || '/';
      } else {
        setDevLoggingIn(null);
      }
    } catch {
      setDevLoggingIn(null);
    }
  };

  if (checking) {
    return (
      <div className={styles['login-container']}>
        <div className={styles['login-split']} data-testid="login-split">
          <div className={styles['login-brand-panel']} data-testid="login-brand-panel" aria-label="Apex brand">
            <div className={styles['login-logo']}>
              <BrandLogo tone="inverse" beta={IS_BETA_RELEASE} align="center" />
            </div>
          </div>
          <div className={styles['login-action-panel']} data-testid="login-action-panel" aria-label="Sign in">
            <p className={styles['login-action-copy']}>Checking authentication...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles['login-container']}>
      <div className={styles['login-split']} data-testid="login-split">
        <div className={styles['login-brand-panel']} data-testid="login-brand-panel" aria-label="Apex brand">
          <div className={styles['login-logo']}>
            <BrandLogo tone="inverse" beta={IS_BETA_RELEASE} align="center" />
          </div>
        </div>

        <div className={styles['login-action-panel']} data-testid="login-action-panel" aria-label="Sign in">
          <div className={styles['login-action-content']}>
            <h1 className={styles['login-action-title']}>Sign in</h1>
            <p className={styles['login-action-copy']}>Continue with your Amergis account.</p>
            <button className={styles['login-button']} onClick={handleLogin}>
              Sign in with Amergis SSO
            </button>

            {devLoginAvailable && devPersonas.length > 0 && (
              <>
                <div className={styles['login-divider']}>
                  <span>or sign in as</span>
                </div>
                <div className={styles['dev-login-buttons']}>
                  {devPersonas.map((persona) => (
                    <button
                      key={persona.id}
                      className={styles['dev-login-button']}
                      onClick={() => handleDevLogin(persona.id)}
                      disabled={devLoggingIn !== null}
                      title={persona.displayName}
                    >
                      {devLoggingIn === persona.id ? 'Signing in...' : persona.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
