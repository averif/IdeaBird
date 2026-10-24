import { useEffect, useState } from 'react';
import { apiJson } from '../auth/client';
import type { HistoryItem, HistorySummary, ToastType } from '../types';
import { TweetCard } from './ResultsStep';

interface HistoryStepProps {
  active: boolean;
  onNew: () => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function HistoryStep({ active, onNew, showToast }: HistoryStepProps) {
  const [items, setItems] = useState<HistorySummary[] | null>(null);
  const [openItem, setOpenItem] = useState<HistoryItem | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    setOpenItem(null);
    apiJson<{ items: HistorySummary[] }>('/api/history')
      .then(({ items }) => setItems(items))
      .catch((err: Error) => {
        setItems([]);
        showToast(err.message, 'error');
      });
  }, [active, showToast]);

  const open = async (id: string) => {
    try {
      const { item } = await apiJson<{ item: HistoryItem }>(`/api/history/${encodeURIComponent(id)}`);
      setCopiedIndex(null);
      setOpenItem(item);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not open that generation.', 'error');
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this generation? This cannot be undone.')) return;
    try {
      await apiJson(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setItems((current) => current?.filter((item) => item.id !== id) ?? null);
      if (openItem?.id === id) setOpenItem(null);
      showToast('Generation deleted.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not delete that generation.', 'error');
    }
  };

  const copy = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      showToast('Tweet copied to clipboard.', 'success');
    } catch {
      showToast('Failed to copy. Please select and copy manually.', 'error');
    }
  };

  return (
    <section className={`step step-history${active ? ' active' : ''}`} id="step-history">
      <div className="step-header compact">
        <span className="eyebrow">History</span>
        <h2>{openItem ? dateFormat.format(new Date(openItem.createdAt)) : 'Your drafts.'}</h2>
        <p className="step-desc">{openItem ? 'Click a card to copy.' : 'Only you can see these.'}</p>
      </div>

      {openItem ? (
        <>
          <div className="history-source">
            <div className="panel-header">
              <span>Source text</span>
            </div>
            <p>{openItem.sourceText}</p>
          </div>
          <div className="tweets-grid">
            {openItem.tweets.map((t, i) => (
              <TweetCard key={`${i}-${t.tweet}`} tweet={t} index={i} copied={copiedIndex === i} onCopy={() => copy(t.tweet, i)} />
            ))}
          </div>
          <div className="step-actions">
            <button className="btn btn-ghost" type="button" onClick={() => setOpenItem(null)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
              All drafts
            </button>
            <button className="btn btn-ghost btn-danger" type="button" onClick={() => remove(openItem.id)}>Delete</button>
          </div>
        </>
      ) : (
        <>
          {items === null ? (
            <p className="history-empty">Loading...</p>
          ) : items.length === 0 ? (
            <p className="history-empty">No generations yet. They'll show up here after you generate posts.</p>
          ) : (
            <ul className="history-list">
              {items.map((item) => (
                <li key={item.id} className="history-row">
                  <button type="button" className="history-open" onClick={() => open(item.id)}>
                    <span className="history-date">{dateFormat.format(new Date(item.createdAt))}</span>
                    <span className="history-preview">{item.preview}</span>
                  </button>
                  <button type="button" className="history-delete" aria-label="Delete generation" onClick={() => remove(item.id)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="step-actions center">
            <button className="btn btn-primary" type="button" onClick={onNew}>
              New screenshot
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
            </button>
          </div>
        </>
      )}
    </section>
  );
}
