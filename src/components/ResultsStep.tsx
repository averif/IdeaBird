import { useEffect, useState } from 'react';
import type { ToastType, Tweet } from '../types';

interface ResultsStepProps {
  active: boolean;
  tweets: Tweet[];
  isGenerating: boolean;
  onRegenerate: () => void;
  onStartOver: () => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

function getContentMaxLength(style: string): number {
  if (style === 'Thread') return 1800;
  if (style === 'LinkedIn Version') return 1400;
  return 280;
}

export function ResultsStep({ active, tweets, isGenerating, onRegenerate, onStartOver, showToast }: ResultsStepProps) {
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
      <div className="step-header compact">
        <span className="eyebrow">Drafts</span>
        <h2>Pick one.</h2>
        <p className="step-desc">Click a card to copy.</p>
      </div>
      <div className="tweets-grid" id="tweets-grid">
        {tweets.map((t, i) => (
          <TweetCard
            key={`${i}-${t.tweet}`}
            tweet={t}
            index={i}
            copied={copiedIndex === i}
            onCopy={() => copyTweet(t.tweet, i)}
          />
        ))}
      </div>
      <div className="step-actions center">
        <button className="btn btn-ghost" id="btn-regenerate" type="button" disabled={isGenerating} onClick={onRegenerate}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-9 9 8.8 8.8 0 0 1-6-2.3" /><path d="M3 12a9 9 0 0 1 15-6.7" /><path d="M3 17v4h4" /><path d="M21 7V3h-4" /></svg>
          Regenerate
        </button>
        <button className="btn btn-primary" id="btn-start-over" type="button" onClick={onStartOver}>
          New screenshot
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
        </button>
      </div>
    </section>
  );
}

interface TweetCardProps {
  tweet: Tweet;
  index: number;
  copied: boolean;
  onCopy: () => void;
}

function TweetCard({ tweet: t, index, copied, onCopy }: TweetCardProps) {
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
      <div className="tweet-card-bottom">
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
