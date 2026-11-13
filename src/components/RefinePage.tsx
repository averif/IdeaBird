import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ApiCodeError, AuthRequiredError, refinePost, type RefinePlatform } from '../api';
import type { ToastType, Usage } from '../types';
import './refine.css';

interface RefinePageProps {
  active: boolean;
  isPro: boolean;
  usage: Usage | null;
  onUsage: (usage: Usage) => void;
  /** Free only: the separate monthly refine allowance. */
  refineUsage: Usage | null;
  onRefineUsage: (usage: Usage | null) => void;
  onUpgrade: () => void;
  onAuthRequired: () => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

interface Turn {
  id: number;
  input: string;
  platform: RefinePlatform;
  status: 'loading' | 'done' | 'error';
  refined?: string;
  changes?: string[];
  error?: string;
  /** A built-in example: shown instantly, no refine used. */
  sample?: boolean;
}

/**
 * Before/after examples shown instantly from the empty state, so people see
 * what Refine does without spending a refine. Written in Refine's own style.
 */
const SAMPLES: { label: string; input: string; platform: RefinePlatform; refined: string; changes: string[] }[] = [
  {
    label: 'A one-line thought',
    input: 'consistency beats talent',
    platform: 'x',
    refined:
      'Talent is a spark: bright, sudden, and gone by morning. Consistency is the hearth. It asks for nothing grand, only that you return each day and tend it, and in time it warms a whole house while the spark is still being admired.',
    changes: ['Turned the claim into an image: spark against hearth', 'Expanded one line into a short, quotable piece', 'Ended on the payoff of showing up'],
  },
  {
    label: 'A rough tweet',
    input: 'shipped my first app after 8 months. only 12 users so far but honestly im proud of it',
    platform: 'x',
    refined:
      "8 months of building, and today it ships. Only 12 users so far, but every one of them is a stranger who chose to try something I made from nothing. I'm proud of it. Small beginnings aren't small to the one who began.",
    changes: ["im → I'm", 'Gave the 12 users weight instead of apologizing for them', 'Closed on a line worth quoting'],
  },
  {
    label: 'A LinkedIn post',
    input:
      'I got rejected from 30 jobs last year. It was hard but I learned a lot about myself. Now I have a job I love. Dont give up if you are going through the same thing.',
    platform: 'linkedin',
    refined:
      "Last year, 30 companies told me no.\n\nEach rejection felt like a verdict at the time. Looking back, they were closer to a chisel: every no cut away a version of my career I thought I wanted, until what remained was the one I actually did.\n\nToday I have a job I love, and I would not trade a single one of those 30 letters for it.\n\nIf you're in the middle of your own string of no's, don't give up. You're not being refused. You're being shaped.",
    changes: ["Dont → Don't",'Recast the rejections as a chisel rather than a verdict', 'Opened on a standalone line and ended on a reframe'],
  },
];

const X_LIMIT = 280;
const MAX_LENGTH = 3000;
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Refined text with the words the editor changed or added marked. */
function markEdits(original: string, refined: string): { text: string; edited: boolean }[] {
  const a = original.split(/(\s+)/).filter(Boolean);
  const b = refined.split(/(\s+)/).filter(Boolean);
  const norm = (t: string) => t.toLowerCase();
  // Longest common subsequence over tokens (whitespace included, so layout survives).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = norm(a[i]) === norm(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: { text: string; edited: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && norm(a[i]) === norm(b[j])) {
      out.push({ text: b[j], edited: false });
      i++;
      j++;
    } else if (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      out.push({ text: b[j], edited: !/^\s+$/.test(b[j]) });
      j++;
    }
  }
  return out;
}

/** Paste a post, get it back refined. Pro uses generations; Free has a monthly number of refines. */
export function RefinePage({ active, isPro, usage, onUsage, refineUsage, onRefineUsage, onUpgrade, onAuthRequired, showToast }: RefinePageProps) {
  const [draft, setDraft] = useState('');
  const [platform, setPlatform] = useState<RefinePlatform>('x');
  const [platformTouched, setPlatformTouched] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  // Off by default: a refine rewrites most of the post, so nearly everything would be marked.
  const [highlight, setHighlight] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const busy = turns.some((t) => t.status === 'loading');

  // Grow the box with its text, like a chat composer.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft]);

  // Longer than a tweet reads as a LinkedIn post, until the user picks one.
  useEffect(() => {
    if (!platformTouched) setPlatform(draft.length > X_LIMIT ? 'linkedin' : 'x');
  }, [draft, platformTouched]);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const scrollToEnd = () => requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }));

  const run = async (id: number, input: string, target: RefinePlatform) => {
    try {
      const data = await refinePost(input, target);
      if (!data.refined) throw new Error('IdeaBird did not receive a refined post.');
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, status: 'done', refined: data.refined, changes: data.changes ?? [] } : t)));
      if (data.usage) onUsage(data.usage);
      if (data.refines !== undefined) onRefineUsage(data.refines);
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        setTurns((all) => all.filter((t) => t.id !== id));
        onAuthRequired();
        return;
      }
      if (err instanceof ApiCodeError && (err.code === 'limit_reached' || err.code === 'pro_required')) {
        showToast(err.message, 'error', 8000);
        if (!isPro && refineUsage) onRefineUsage({ ...refineUsage, used: refineUsage.limit });
        setTurns((all) => all.filter((t) => t.id !== id));
        onUpgrade();
        return;
      }
      const message = err instanceof Error ? err.message : 'Could not refine this post. Please try again.';
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, status: 'error', error: message } : t)));
    } finally {
      scrollToEnd();
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const input = draft.trim();
    if (!input || busy) return;
    if (words(input) < 3) {
      showToast('Paste a post of at least a few words to refine.', 'error');
      return;
    }
    const id = nextId.current++;
    setTurns((all) => [...all, { id, input, platform, status: 'loading' }]);
    setDraft('');
    setPlatformTouched(false);
    scrollToEnd();
    run(id, input, platform);
  };

  const showSample = (sample: (typeof SAMPLES)[number]) => {
    const id = nextId.current++;
    setTurns((all) => [...all, { id, input: sample.input, platform: sample.platform, status: 'done', refined: sample.refined, changes: sample.changes, sample: true }]);
    scrollToEnd();
  };

  const retry = (turn: Turn) => {
    if (busy) return;
    setTurns((all) => all.map((t) => (t.id === turn.id ? { ...t, status: 'loading', error: undefined, sample: false } : t)));
    run(turn.id, turn.input, turn.platform);
  };

  const editOriginal = (turn: Turn) => {
    setDraft(turn.input);
    setPlatform(turn.platform);
    setPlatformTouched(true);
    inputRef.current?.focus();
  };

  const copy = async (turn: Turn) => {
    if (!turn.refined) return;
    try {
      await navigator.clipboard.writeText(turn.refined);
      setCopiedId(turn.id);
      showToast('Refined post copied.', 'success');
    } catch {
      showToast('Failed to copy. Please select and copy manually.', 'error');
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a line (posts often have several).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const overX = platform === 'x' && draft.length > X_LIMIT;
  const left = usage ? Math.max(0, usage.limit - usage.used) : null;
  // Free: refines come from their own monthly allowance.
  const refinesLeft = !isPro && refineUsage ? Math.max(0, refineUsage.limit - refineUsage.used) : null;
  const outOfRefines = refinesLeft === 0;

  return (
    <section className={`step step-refine${active ? ' active' : ''}`} id="step-refine">
      <div className="page-head">
        <div>
          <h2>Refine</h2>
          <p>Paste a post or a rough thought. IdeaBird turns it into something eloquent, wise and worth quoting.</p>
        </div>
        {turns.length > 0 && (
          <div className="page-actions">
            <label className="refine-toggle">
              <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} />
              Highlight edits
            </label>
            <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => setTurns([])}>
              Clear
            </button>
          </div>
        )}
      </div>

      <div className="refine-thread">
        {turns.length === 0 && (
          <div className="refine-empty">
            <p>Paste a one-line thought, a tweet, or a LinkedIn post up to 3,000 characters. Or see an example first:</p>
            <ul>
              {SAMPLES.map((sample) => (
                <li key={sample.label}>
                  <button type="button" onClick={() => showSample(sample)}>
                    {sample.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {turns.map((turn) => (
          <div className="refine-turn" key={turn.id}>
            <div className="refine-input">
              <span className="refine-label">{turn.platform === 'x' ? 'Your X post' : 'Your LinkedIn post'}</span>
              <p>{turn.input}</p>
            </div>

            {turn.status === 'loading' && (
              <div className="refine-output loading" aria-live="polite">
                <span className="refine-label">Refining</span>
                <div className="refine-skeleton" aria-hidden="true">
                  <span /><span /><span />
                </div>
              </div>
            )}

            {turn.status === 'error' && (
              <div className="refine-output error" role="alert">
                <p>{turn.error}</p>
                <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => retry(turn)}>
                  Try again
                </button>
              </div>
            )}

            {turn.status === 'done' && turn.refined && (
              <div className="refine-output">
                <div className="refine-output-head">
                  <span className="refine-label">{turn.sample ? 'Refined · example, no refine used' : 'Refined'}</span>
                  {turn.platform === 'x' && (
                    <span className="refine-meta">
                      <span className={turn.refined.length > X_LIMIT ? 'over' : ''}>{turn.refined.length}/{X_LIMIT}</span>
                    </span>
                  )}
                </div>
                <p className="refine-text">
                  {highlight
                    ? markEdits(turn.input, turn.refined).map((part, i) =>
                        part.edited ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>
                      )
                    : turn.refined}
                </p>
                {turn.changes && turn.changes.length > 0 && (
                  <ul className="refine-changes">
                    {turn.changes.map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                )}
                <div className="refine-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    disabled={busy || (turn.sample && outOfRefines)}
                    onClick={() => retry(turn)}
                  >
                    {turn.sample ? 'Refine it live' : 'Try another version'}
                  </button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => editOriginal(turn)}>
                    Edit original
                  </button>
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => copy(turn)}>
                    {copiedId === turn.id ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="refine-composer" onSubmit={submit}>
        <div className="refine-box">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, MAX_LENGTH))}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder="Paste your post here..."
            aria-label="Post to refine"
          />
          <div className="refine-box-bar">
            <div className="refine-platform" role="radiogroup" aria-label="Platform">
              {(['x', 'linkedin'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={platform === option}
                  className={platform === option ? 'active' : ''}
                  onClick={() => {
                    setPlatform(option);
                    setPlatformTouched(true);
                  }}
                >
                  {option === 'x' ? 'X' : 'LinkedIn'}
                </button>
              ))}
            </div>
            <span className={`refine-count${overX ? ' over' : ''}`}>
              {platform === 'x' ? `${draft.length}/${X_LIMIT}` : `${draft.length.toLocaleString('en-US')}/${MAX_LENGTH.toLocaleString('en-US')}`}
            </span>
            <button className="refine-send" type="submit" disabled={busy || !draft.trim() || outOfRefines} aria-label="Refine post">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
        {isPro ? (
          <p className="refine-hint">
            Enter to refine, Shift+Enter for a new line. Each refine uses one generation
            {left !== null ? ` (${left.toLocaleString('en-US')} left this month)` : ''}.
          </p>
        ) : outOfRefines ? (
          <p className="refine-hint">
            You've used all {refineUsage!.limit} free refines this month.{' '}
            <button type="button" onClick={onUpgrade}>Upgrade to Pro</button> to keep refining.
          </p>
        ) : (
          <p className="refine-hint">
            Enter to refine, Shift+Enter for a new line.
            {refinesLeft !== null ? ` ${refinesLeft} of ${refineUsage!.limit} free refines left this month.` : ''}{' '}
            <button type="button" onClick={onUpgrade}>Upgrade</button> for more.
          </p>
        )}
      </form>
    </section>
  );
}
