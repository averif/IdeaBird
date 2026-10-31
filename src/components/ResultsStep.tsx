import { useEffect, useState, type ReactNode } from 'react';
import { PLANS } from '../../shared/plans';
import type { ToastType, Tweet } from '../types';

interface ResultsStepProps {
  active: boolean;
  tweets: Tweet[];
  isGenerating: boolean;
  onRegenerate: () => void;
  onStartOver: () => void;
  /** Free plan: offer the other variations. */
  onUpgrade?: () => void;
  /** Expand a post into a full X thread (Pro). With `expandLocked`, the button leads to Plans. */
  onExpand?: (index: number) => void;
  expandLocked?: boolean;
  expandingIndex?: number | null;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

function getContentMaxLength(style: string): number {
  if (style === 'Thread') return 1800;
  // Expanded thread: up to 10 tweets of 280.
  if (style === 'X Thread') return 2800;
  if (style === 'LinkedIn Version') return 1400;
  return 280;
}

// Formats that are already threads don't get "Expand into thread".
const IS_THREAD = /thread/i;

export function ResultsStep({
  active,
  tweets,
  isGenerating,
  onRegenerate,
  onStartOver,
  onUpgrade,
  onExpand,
  expandLocked = false,
  expandingIndex = null,
  showToast,
}: ResultsStepProps) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => setCopiedIndex(null), [tweets]);

  // --- Copy ---
  const copyTweet = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      showToast('Tweet copied to clipboard.', 'success');
    } catch {
      showToast('Failed to copy. Please select and copy manually.', 'error');
    }
  };

  return (
    <section className={`step step-results${active ? ' active' : ''}`} id="step-results">
      <div className="page-head">
        <div>
          <h2>Drafts</h2>
          <p>{tweets.length > 1 ? `${tweets.length} takes on your screenshot. Click a card to copy it.` : 'Your post. Click it to copy.'}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-sm" type="button" disabled={isGenerating} onClick={onRegenerate}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6-2.3" /><path d="M3 12a9 9 0 0 1 15-6.7" /><path d="M3 17v4h4" /><path d="M21 7V3h-4" /></svg>
            Regenerate
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={onStartOver}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
            New post
          </button>
        </div>
      </div>
      <div className="tweets-grid" id="tweets-grid">
        {tweets.map((t, i) => (
          <TweetCard
            key={`${i}-${t.tweet}`}
            tweet={t}
            index={i}
            copied={copiedIndex === i}
            onCopy={() => copyTweet(t.tweet, i)}
            action={
              onExpand && !IS_THREAD.test(t.style) ? (
                <button
                  className="expand-btn"
                  type="button"
                  disabled={expandingIndex !== null}
                  onClick={(e) => {
                    e.stopPropagation(); // the card itself copies on click
                    if (expandLocked) onUpgrade?.();
                    else onExpand(i);
                  }}
                >
                  {expandingIndex === i ? (
                    <>
                      <span className="expand-spinner" aria-hidden="true" />
                      Writing thread...
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h7" /><path d="M17 15v6" /><path d="M14 18h6" /></svg>
                      Expand into thread
                      {expandLocked && <span className="nav-pro">Pro</span>}
                    </>
                  )}
                </button>
              ) : null
            }
          />
        ))}
      </div>
      {onUpgrade && (
        <div className="upsell">
          <div>
            <strong>Want more angles on this?</strong>
            <p>Pro writes {PLANS.pro.limits.draftsPerGeneration} versions of every post, including a question, a stat-led post, a thread and a LinkedIn version, and saves them to your history.</p>
          </div>
          <button className="btn btn-primary btn-sm" type="button" onClick={onUpgrade}>
            Upgrade to Pro
          </button>
        </div>
      )}
    </section>
  );
}

export interface TweetCardProps {
  tweet: Tweet;
  index: number;
  copied: boolean;
  onCopy: () => void;
  /** Extra button shown next to Copy. */
  action?: ReactNode;
}

export function TweetCard({ tweet: t, index, copied, onCopy, action }: TweetCardProps) {
  const len = t.tweet.length;
  const maxLength = getContentMaxLength(t.style);
  const countLabel = maxLength === 280 ? `${len}/280` : `${len} chars`;

  return (
    <div
      className={`tweet-card${copied ? ' copied' : ''}`}
      style={{ animation: `fadeSlideIn 0.4s ease ${index * 0.08}s forwards`, opacity: 0 }}
      onClick={onCopy}
    >
      <div className="tweet-card-top">
        <span className="tweet-style-badge">{t.style}</span>
        <span className={`tweet-char-count${len > maxLength ? ' over' : ''}`}>{countLabel}</span>
      </div>
      <div className="tweet-text">{t.tweet}</div>
      <div className={`tweet-card-bottom${action ? ' with-action' : ''}`}>
        {action}
        <button className="copy-btn" type="button" data-index={index}>
          {copied ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              Copied!
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
              Copy
            </>
          )}
        </button>
      </div>
    </div>
  );
}
