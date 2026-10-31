import { useEffect, useState } from 'react';
import { INSTRUCTIONS_MAX_LENGTH, TONES } from '../../shared/writing';
import { apiJson } from '../auth/client';
import type { ToastType } from '../types';

interface Preferences {
  tone: string;
  instructions: string;
  /** Pro only. */
  available: boolean;
}

const EXAMPLE = 'e.g. Write in first person as a solo founder. Avoid emojis and hashtags. End X posts with a question when it fits.';

interface WritingPreferencesCardProps {
  /** Reload when the plan changes. */
  plan: string;
  onUpgrade: () => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

/** Settings card: the tone and standing instructions applied to every generation (Pro). */
export function WritingPreferencesCard({ plan, onUpgrade, showToast }: WritingPreferencesCardProps) {
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [tone, setTone] = useState('default');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiJson<Preferences>('/api/preferences')
      .then((prefs) => {
        setSaved(prefs);
        setTone(prefs.tone);
        setInstructions(prefs.instructions);
      })
      .catch(() => setSaved(null));
  }, [plan]);

  if (!saved) return null;

  const dirty = tone !== saved.tone || instructions.trim() !== saved.instructions;
  const tooLong = instructions.length > INSTRUCTIONS_MAX_LENGTH;

  const save = async () => {
    setSaving(true);
    try {
      const next = await apiJson<Preferences>('/api/preferences', { method: 'PUT', body: JSON.stringify({ tone, instructions }) });
      setSaved(next);
      setInstructions(next.instructions);
      showToast('Saved. Your next posts will use it.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not save. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-card" id="writing-preferences">
      <header className="settings-card-head">
        <h3>Tone and instructions</h3>
        <span className="badge">Pro</span>
      </header>

      {!saved.available ? (
        <div className="settings-actions">
          <div className="settings-action">
            <span className="settings-icon" aria-hidden="true">Aa</span>
            <div>
              <strong>Make every post sound the way you want</strong>
              <p>Pick a tone and add standing instructions, like "first person, no emojis". IdeaBird applies them to every post.</p>
            </div>
            <button className="btn btn-primary btn-sm" type="button" onClick={onUpgrade}>
              Upgrade to Pro
            </button>
          </div>
        </div>
      ) : (
        <div className="prefs">
          <fieldset className="prefs-field">
            <legend>Tone</legend>
            <div className="chip-row" role="radiogroup" aria-label="Tone">
              {TONES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={tone === option.id}
                  className={`chip${tone === option.id ? ' selected' : ''}`}
                  onClick={() => setTone(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="prefs-hint">{TONES.find((t) => t.id === tone)?.description}</p>
          </fieldset>

          <label className="prefs-field">
            <span className="prefs-label">Writing instructions</span>
            <textarea
              rows={4}
              value={instructions}
              placeholder={EXAMPLE}
              maxLength={INSTRUCTIONS_MAX_LENGTH * 2}
              onChange={(e) => setInstructions(e.target.value)}
            />
            <span className={`prefs-count${tooLong ? ' over' : ''}`}>
              {instructions.length}/{INSTRUCTIONS_MAX_LENGTH}
            </span>
          </label>
          <p className="prefs-hint">These shape how posts are written. They never change the facts from your screenshot.</p>

          <div className="prefs-actions">
            <button className="btn btn-primary btn-sm" type="button" disabled={!dirty || tooLong || saving} onClick={save}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
