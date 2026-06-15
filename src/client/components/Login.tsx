import React, { useEffect, useState } from 'react';
import { BrandLogo } from './BrandLogo';
import styles from './Login.module.css';

export const Login: React.FC = () => {
  const [checking, setChecking] = useState(true);
  const [devLoginAvailable, setDevLoginAvailable] = useState(false);
  const [devLoggingIn, setDevLoggingIn] = useState(false);

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
      .then(data => { if (data?.available) setDevLoginAvailable(true); })
      .catch(() => {});

    Promise.allSettled([checkAuth, checkDev]);
  }, []);

  const handleLogin = () => { window.location.href = '/auth/login'; };

  const handleDevLogin = async () => {
    setDevLoggingIn(true);
    try {
      const res = await fetch('/auth/dev-login', {
        method: 'POST',
        credentials: 'include',
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        setDevLoggingIn(false);
      }
    } catch {
      setDevLoggingIn(false);
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

        {devLoginAvailable && (
          <>
            <div className={styles['login-divider']}>
              <span>or</span>
            </div>
            <button
              className={styles['dev-login-button']}
              onClick={handleDevLogin}
              disabled={devLoggingIn}
            >
              {devLoggingIn ? 'Signing in...' : 'Sign in as Dev User'}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
