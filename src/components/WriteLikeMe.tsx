import type { VoiceControls } from '../voice';
import { PenIcon, RefreshIcon, UnlinkIcon } from './icons';

const TRAIT_LABELS: Record<string, string> = {
  tone: 'Tone',
  sentenceStyle: 'Sentences',
  vocabulary: 'Vocabulary',
  hooks: 'Hooks',
  structure: 'Structure',
  punctuation: 'Punctuation',
  emoji: 'Emoji',
  humor: 'Humor',
};

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? ' on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

/** Settings card: connect X, see the learned voice, toggle, refresh, disconnect. */
export function WriteLikeMeCard({ controls }: { controls: VoiceControls }) {
  const { voice, learning, busy, learn, connect, setEnabled, disconnect } = controls;
  if (!voice) return null;

  const { connection, profile } = voice;
  const locked = busy || learning;

  return (
    <section className="settings-card" id="write-like-me">
      <header>
        <h3>Write Like Me</h3>
      </header>

      {!voice.available ? (
        <div className="settings-actions">
          <div className="settings-action">
            <span className="settings-icon"><PenIcon /></span>
            <div>
              <strong>Write in your own voice</strong>
              <p>
                {import.meta.env.DEV
                  ? 'Not set up on this server yet. Add X_CLIENT_ID and X_CLIENT_SECRET to .env (see .env.example), then restart the API.'
                  : "Connecting X isn't available yet. IdeaBird keeps writing in its default voice."}
              </p>
            </div>
            <button className="btn btn-primary btn-sm" type="button" disabled>
              Connect X
            </button>
          </div>
        </div>
      ) : !connection ? (
        <div className="settings-actions">
          <div className="settings-action">
            <span className="settings-icon"><PenIcon /></span>
            <div>
              <strong>Connect X to write in your voice</strong>
              <p>IdeaBird reads your recent posts once to learn how you write. Read-only: it can't post, like, follow or change anything.</p>
            </div>
            <button className="btn btn-primary btn-sm" type="button" disabled={locked} onClick={connect}>
              Connect X
            </button>
          </div>
        </div>
      ) : (
        <>
          {learning ? (
            <div className="voice-learning" role="status">
              <span className="voice-spinner" aria-hidden="true" />
              Learning your voice from your recent posts on X...
            </div>
          ) : profile ? (
            <div className="voice-profile">
              <p className="voice-summary">{profile.summary || 'Your voice is ready.'}</p>
              <dl className="voice-traits">
                {Object.entries(profile.traits)
                  .filter(([, items]) => items.length)
                  .map(([key, items]) => (
                    <div key={key}>
                      <dt>{TRAIT_LABELS[key] ?? key}</dt>
                      <dd>{items.join(' · ')}</dd>
                    </div>
                  ))}
                {profile.avoid.length > 0 && (
                  <div>
                    <dt>Avoids</dt>
                    <dd>{profile.avoid.join(' · ')}</dd>
                  </div>
                )}
                <div>
                  <dt>Measured</dt>
                  <dd>{profile.measured.join(' · ')}</dd>
                </div>
              </dl>
              <p className="voice-meta">
                Learned from {profile.postCount} posts by @{connection.username} · {new Date(profile.updatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}. Your posts
                themselves aren't saved.
              </p>
            </div>
          ) : null}

          <div className="settings-actions">
            {connection.status === 'expired' ? (
              <div className="settings-action">
                <span className="settings-icon"><RefreshIcon /></span>
                <div>
                  <strong>Your X connection needs to be refreshed.</strong>
                  <p>Reconnect to update your voice.{profile ? ' Your current voice keeps working until then.' : ''}</p>
                </div>
                <button className="btn btn-primary btn-sm" type="button" disabled={locked} onClick={connect}>
                  Reconnect X
                </button>
              </div>
            ) : (
              <div className="settings-action">
                <span className="settings-icon"><RefreshIcon /></span>
                <div>
                  <strong>{profile ? 'Refresh my voice' : 'Learn my voice'}</strong>
                  <p>{profile ? 'Re-reads your latest posts. Use it when your style changes.' : "We haven't learned your voice yet. It reads your recent original posts once."}</p>
                </div>
                <button className={`btn btn-sm ${profile ? 'btn-ghost' : 'btn-primary'}`} type="button" disabled={locked} onClick={learn}>
                  {learning ? 'Learning...' : profile ? 'Refresh' : 'Learn my voice'}
                </button>
              </div>
            )}

            {profile && (
              <div className="settings-action">
                <span className="settings-icon"><PenIcon /></span>
                <div>
                  <strong>Write like me</strong>
                  <p>{profile.enabled ? 'New posts use your voice.' : "New posts use IdeaBird's default voice."}</p>
                </div>
                <Switch checked={profile.enabled} disabled={locked} label="Write like me" onChange={setEnabled} />
              </div>
            )}

            <div className="settings-action">
              <span className="settings-icon"><UnlinkIcon /></span>
              <div>
                <strong>Disconnect X</strong>
                <p>Connected as @{connection.username}. Disconnecting revokes IdeaBird's access and deletes your voice profile.</p>
              </div>
              <button className="btn btn-ghost btn-sm btn-danger" type="button" disabled={locked} onClick={disconnect}>
                Disconnect
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** Compact toggle on the Insights step, shown once a voice has been learned. */
export function VoiceToggle({ controls }: { controls: VoiceControls }) {
  const { voice, busy, learning, setEnabled } = controls;
  const profile = voice?.profile;
  if (!voice?.available || !profile) return null;

  return (
    <div className="voice-toggle">
      <Switch checked={profile.enabled} disabled={busy || learning} label="Write like me" onChange={setEnabled} />
      <span>
        <strong>Write like me</strong>
        {voice.connection ? <span className="muted-text"> · @{voice.connection.username}</span> : null}
      </span>
    </div>
  );
}
