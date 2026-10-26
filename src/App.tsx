import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { AuthModal, type AuthMode } from './auth/AuthModal';
import { Toast, useToast } from './components/Toast';
import Dashboard from './Dashboard';
import Landing from './landing/Landing';

/**
 * Signed-out visitors see the landing page; logging in or signing up (in the
 * auth modal) takes them to the dashboard. Email links (?verify, ?reset) are
 * handled here so they work from either screen.
 */
export default function App() {
  const auth = useAuth();
  const { toast, showToast } = useToast();
  const [authModal, setAuthModal] = useState<{ mode: AuthMode; reason?: string } | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);

  const openAuth = useCallback((mode: AuthMode, reason?: string) => setAuthModal({ mode, reason }), []);

  // Email links land on /?verify=<token> or /?reset=<token>. Strip the token from
  // the address bar (and so from history and Referer headers) right away.
  const handledLinkRef = useRef(false);
  useEffect(() => {
    if (handledLinkRef.current) return;
    handledLinkRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const verify = params.get('verify');
    const reset = params.get('reset');
    if (!verify && !reset) return;
    window.history.replaceState(null, '', window.location.pathname);

    if (reset) {
      setResetToken(reset);
      setAuthModal({ mode: 'reset' });
    } else if (verify) {
      auth
        .verifyEmail(verify)
        .then(() => showToast('Email verified. Thanks!', 'success'))
        .catch((err: Error) => showToast(err.message, 'error', 5000));
    }
  }, [auth, showToast]);

  const onAuthenticated = useCallback(() => {
    setAuthModal(null);
    setResetToken(null);
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <>
      {auth.status === 'loading' ? (
        <div className="splash" aria-label="Loading" />
      ) : auth.status === 'authenticated' ? (
        <Dashboard openAuth={openAuth} showToast={showToast} />
      ) : (
        <Landing onLogin={() => openAuth('login')} onSignup={() => openAuth('signup')} />
      )}

      {authModal && (
        <AuthModal
          mode={authModal.mode}
          reason={authModal.reason}
          resetToken={resetToken}
          onModeChange={(mode) => setAuthModal((current) => ({ ...current, mode }))}
          onClose={() => setAuthModal(null)}
          onAuthenticated={onAuthenticated}
        />
      )}
      <Toast toast={toast} />
    </>
  );
}
