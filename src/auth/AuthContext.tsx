import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { User } from '../types';
import { apiJson, onSessionChange, refreshSession, setSession, type SessionResponse } from './client';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthValue {
  status: Status;
  user: User | null;
  googleClientId: string | null;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string, name?: string): Promise<void>;
  loginWithGoogle(credential: string): Promise<void>;
  logout(): Promise<void>;
  logoutEverywhere(): Promise<void>;
  forgotPassword(email: string): Promise<string>;
  resetPassword(token: string, password: string): Promise<void>;
  verifyEmail(token: string): Promise<void>;
  resendVerification(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  useEffect(() => {
    onSessionChange((next) => {
      setUser(next);
      setStatus(next ? 'authenticated' : 'anonymous');
    });

    // Restore the session from the refresh cookie, if there is one.
    refreshSession();
    apiJson<{ googleClientId: string | null }>('/api/auth/config', {}, false)
      .then(({ googleClientId }) => setGoogleClientId(googleClientId))
      .catch(() => setGoogleClientId(null));
  }, []);

  const startSession = useCallback(async (path: string, body: unknown) => {
    setSession(await apiJson<SessionResponse>(path, post(body), false));
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      googleClientId,
      login: (email, password) => startSession('/api/auth/login', { email, password }),
      signup: (email, password, name) => startSession('/api/auth/signup', { email, password, name }),
      loginWithGoogle: (credential) => startSession('/api/auth/google', { credential }),
      resetPassword: (token, password) => startSession('/api/auth/reset-password', { token, password }),
      async logout() {
        await apiJson('/api/auth/logout', { method: 'POST' }, false).catch(() => {});
        setSession(null);
      },
      async logoutEverywhere() {
        await apiJson('/api/auth/logout-all', { method: 'POST' });
        setSession(null);
      },
      async forgotPassword(email) {
        const { message } = await apiJson<{ message: string }>('/api/auth/forgot-password', post({ email }), false);
        return message;
      },
      async verifyEmail(token) {
        await apiJson('/api/auth/verify-email', post({ token }), false);
        setUser((current) => current && { ...current, emailVerified: true });
      },
      async resendVerification() {
        await apiJson('/api/auth/resend-verification', { method: 'POST' });
      },
    }),
    [status, user, googleClientId, startSession]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
