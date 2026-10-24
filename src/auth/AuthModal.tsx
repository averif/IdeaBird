import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { GoogleButton } from './GoogleButton';

export type AuthMode = 'login' | 'signup' | 'forgot' | 'reset';

interface AuthModalProps {
  mode: AuthMode;
  resetToken?: string | null;
  /** Shown above the form, e.g. why sign-in is needed. */
  reason?: string | null;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  onAuthenticated: () => void;
}

const TITLES: Record<AuthMode, string> = {
  login: 'Welcome back',
  signup: 'Create your account',
  forgot: 'Reset your password',
  reset: 'Choose a new password',
};

const SUBTITLES: Record<AuthMode, string> = {
  login: 'Log in to generate posts and see your history.',
  signup: 'Save every generation to your private history.',
  forgot: "Enter your email and we'll send you a reset link.",
  reset: 'Use at least 8 characters.',
};

export function AuthModal({ mode, resetToken, reason, onModeChange, onClose, onAuthenticated }: AuthModalProps) {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setPassword('');
    setConfirm('');
    firstFieldRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    run(async () => {
      if (mode === 'login') {
        await auth.login(email, password);
        onAuthenticated();
      } else if (mode === 'signup') {
        await auth.signup(email, password, name.trim() || undefined);
        onAuthenticated();
      } else if (mode === 'forgot') {
        setNotice(await auth.forgotPassword(email));
      } else {
        if (password !== confirm) throw new Error("Passwords don't match.");
        await auth.resetPassword(resetToken || '', password);
        onAuthenticated();
      }
    });
  };

  const { loginWithGoogle } = auth;
  // Stable so the Google button isn't re-initialized on every render.
  const onGoogleCredential = useCallback(
    (credential: string) => {
      setBusy(true);
      setError(null);
      loginWithGoogle(credential)
        .then(onAuthenticated)
        .catch((err: Error) => setError(err.message))
        .finally(() => setBusy(false));
    },
    [loginWithGoogle, onAuthenticated]
  );
  const onGoogleError = useCallback((message: string) => setError(message), []);

  const showGoogle = (mode === 'login' || mode === 'signup') && auth.googleClientId;
  const needsEmail = mode !== 'reset';
  const needsPassword = mode !== 'forgot';

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>

        <div className="modal-header">
          <h2 id="auth-title">{TITLES[mode]}</h2>
          <p>{reason && (mode === 'login' || mode === 'signup') ? reason : SUBTITLES[mode]}</p>
        </div>

        {showGoogle && (
          <>
            <GoogleButton clientId={auth.googleClientId!} onCredential={onGoogleCredential} onError={onGoogleError} />
            <div className="divider"><span>or</span></div>
          </>
        )}

        {notice ? (
          <p className="form-notice">{notice}</p>
        ) : (
          <form className="auth-form" onSubmit={onSubmit} noValidate>
            {mode === 'signup' && (
              <label className="field">
                <span>Name <em>(optional)</em></span>
                <input ref={firstFieldRef} type="text" autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            )}
            {needsEmail && (
              <label className="field">
                <span>Email</span>
                <input
                  ref={mode === 'signup' ? undefined : firstFieldRef}
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            )}
            {needsPassword && (
              <label className="field">
                <span className="field-row">
                  {mode === 'reset' ? 'New password' : 'Password'}
                  {mode === 'login' && (
                    <button type="button" className="link-button" onClick={() => onModeChange('forgot')}>
                      Forgot password?
                    </button>
                  )}
                </span>
                <input
                  ref={mode === 'reset' ? firstFieldRef : undefined}
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={mode === 'login' ? undefined : 8}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            )}
            {mode === 'reset' && (
              <label className="field">
                <span>Confirm password</span>
                <input type="password" autoComplete="new-password" required maxLength={128} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </label>
            )}
            {mode === 'signup' && <p className="field-hint">At least 8 characters. A short phrase works well.</p>}

            {error && <p className="form-error" role="alert">{error}</p>}

            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
              {busy ? 'Please wait...' : { login: 'Log in', signup: 'Create account', forgot: 'Send reset link', reset: 'Update password' }[mode]}
            </button>
          </form>
        )}

        <p className="modal-switch">
          {mode === 'login' && (
            <>New to IdeaBird? <button type="button" className="link-button" onClick={() => onModeChange('signup')}>Create an account</button></>
          )}
          {mode === 'signup' && (
            <>Already have an account? <button type="button" className="link-button" onClick={() => onModeChange('login')}>Log in</button></>
          )}
          {(mode === 'forgot' || mode === 'reset') && (
            <button type="button" className="link-button" onClick={() => onModeChange('login')}>Back to log in</button>
          )}
        </p>
        {mode === 'signup' && (
          <p className="modal-legal">
            By continuing you agree to the <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a>.
          </p>
        )}
      </div>
    </div>
  );
}
