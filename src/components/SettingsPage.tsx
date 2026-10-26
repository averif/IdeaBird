import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { ToastType } from '../types';
import { DevicesIcon, LogOutIcon, MailIcon, ShieldIcon } from './icons';

interface SettingsPageProps {
  active: boolean;
  draftCount: number | null;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

export function SettingsPage({ active, draftCount, showToast }: SettingsPageProps) {
  const { user, logout, logoutEverywhere, forgotPassword } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);

  if (!user) return null;

  const run = (key: string, action: () => Promise<unknown>, success?: string) => async () => {
    setBusy(key);
    try {
      const result = await action();
      showToast(typeof result === 'string' ? result : success ?? 'Done.', 'success', 5000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const methods = [user.hasPassword && 'Email and password', user.googleLinked && 'Google'].filter(Boolean).join(' · ');

  return (
    <section className={`step step-settings${active ? ' active' : ''}`} id="step-settings">
      <div className="page-head">
        <div>
          <h2>Settings</h2>
          <p>Your account and security.</p>
        </div>
      </div>

      <div className="settings">
        <section className="settings-card">
          <header>
            <h3>Account</h3>
          </header>
          <dl className="settings-rows">
            <div>
              <dt>Name</dt>
              <dd>{user.name || <span className="muted-text">Not set</span>}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>
                {user.email}
                {user.emailVerified && <span className="badge">Verified</span>}
              </dd>
            </div>
            <div>
              <dt>Sign-in method</dt>
              <dd>{methods || 'Email'}</dd>
            </div>
            <div>
              <dt>Saved drafts</dt>
              <dd>{draftCount ?? '—'}</dd>
            </div>
          </dl>
        </section>

        <section className="settings-card">
          <header>
            <h3>Security</h3>
          </header>
          <div className="settings-actions">
            <div className="settings-action">
              <span className="settings-icon"><MailIcon /></span>
              <div>
                <strong>{user.hasPassword ? 'Change password' : 'Set a password'}</strong>
                <p>We'll email you a secure link to choose a new password.</p>
              </div>
              <button className="btn btn-ghost btn-sm" type="button" disabled={busy !== null} onClick={run('reset', () => forgotPassword(user.email))}>
                {busy === 'reset' ? 'Sending...' : 'Send link'}
              </button>
            </div>
            <div className="settings-action">
              <span className="settings-icon"><DevicesIcon /></span>
              <div>
                <strong>Log out of all devices</strong>
                <p>Ends every session, including this one. Use it if you think someone else has access.</p>
              </div>
              <button className="btn btn-ghost btn-sm btn-danger" type="button" disabled={busy !== null} onClick={run('all', logoutEverywhere, 'Logged out on all devices.')}>
                Log out everywhere
              </button>
            </div>
            <div className="settings-action">
              <span className="settings-icon"><LogOutIcon /></span>
              <div>
                <strong>Log out</strong>
                <p>Sign out on this device only.</p>
              </div>
              <button className="btn btn-ghost btn-sm" type="button" disabled={busy !== null} onClick={run('out', logout, 'Logged out.')}>
                Log out
              </button>
            </div>
          </div>
        </section>

        <section className="settings-card">
          <header>
            <h3>Privacy</h3>
          </header>
          <div className="settings-actions">
            <div className="settings-action">
              <span className="settings-icon"><ShieldIcon /></span>
              <div>
                <strong>Your screenshots aren't stored</strong>
                <p>Images are analyzed and discarded. Only a short summary and your drafts are saved, and you can delete them from History.</p>
              </div>
              <a className="btn btn-ghost btn-sm" href="/terms.html" target="_blank" rel="noreferrer">
                Read terms
              </a>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
