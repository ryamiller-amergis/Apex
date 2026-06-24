import React, { useEffect, useState } from 'react';
import type { DevMockPersonaId } from '../../shared/constants/devMockUsers';
import { BrandLogo } from './BrandLogo';
import styles from './Login.module.css';

interface DevLoginPersona {
  id: DevMockPersonaId;
  label: string;
  displayName: string;
}

export const Login: React.FC = () => {
  const [checking, setChecking] = useState(true);
  const [devLoginAvailable, setDevLoginAvailable] = useState(false);
  const [devPersonas, setDevPersonas] = useState<DevLoginPersona[]>([]);
  const [devLoggingIn, setDevLoggingIn] = useState<DevMockPersonaId | null>(null);

  useEffect(() => {
    const checkAuth = fetch('/auth/status', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.authenticated) {
          window.location.href = '/';
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

  const handleLogin = () => { window.location.href = '/auth/login'; };

  const handleDevLogin = async (persona: DevMockPersonaId) => {
    setDevLoggingIn(persona);
    try {
      const res = await fetch('/auth/dev-login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona }),
      });
      if (res.ok) {
        window.location.href = '/';
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
        <div className={styles['login-card']}>
          <p>Checking authentication...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles['login-container']}>
      <div className={styles['login-card']}>
        <div className={styles['login-logo']}>
          <BrandLogo tone="inverse" />
        </div>
        <p>Sign in with your Amergis account to continue.</p>
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
  );
};
