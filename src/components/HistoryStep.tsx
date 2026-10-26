import { useEffect, useMemo, useState } from 'react';
import { apiJson } from '../auth/client';
import type { HistoryItem, HistorySummary, ToastType } from '../types';
import { BackIcon, PlusIcon, SearchIcon, TrashIcon } from './icons';
import { TweetCard } from './ResultsStep';

interface HistoryStepProps {
  active: boolean;
  items: HistorySummary[] | null;
  /** Id to open (e.g. clicked in the sidebar's Recent list); null shows the list. */
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  onDeleted: (id: string) => void;
  onNew: () => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function HistoryStep({ active, items, openId, onOpenChange, onDeleted, onNew, showToast }: HistoryStepProps) {
  const [openItem, setOpenItem] = useState<HistoryItem | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [query, setQuery] = useState('');

  // Load the selected draft whenever the requested id changes.
  useEffect(() => {
    if (!openId) {
      setOpenItem(null);
      return;
    }
    if (openItem?.id === openId) return;
    let cancelled = false;
    apiJson<{ item: HistoryItem }>(`/api/history/${encodeURIComponent(openId)}`)
      .then(({ item }) => {
        if (cancelled) return;
        setCopiedIndex(null);
        setOpenItem(item);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        showToast(err.message || 'Could not open that draft.', 'error');
        onOpenChange(null);
      });
    return () => {
      cancelled = true;
    };
  }, [openId, openItem?.id, onOpenChange, showToast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items?.filter((item) => item.preview.toLowerCase().includes(q)) ?? null : items;
  }, [items, query]);

  const remove = async (id: string) => {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return;
    try {
      await apiJson(`/api/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
      onDeleted(id);
      if (openId === id) onOpenChange(null);
      showToast('Draft deleted.', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not delete that draft.', 'error');
    }
  };

  const copy = async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      showToast('Copied to clipboard.', 'success');
    } catch {
      showToast('Failed to copy. Please select and copy manually.', 'error');
    }
  };

  const showingItem = openId && openItem?.id === openId ? openItem : null;

  return (
    <section className={`step step-history${active ? ' active' : ''}`} id="step-history">
      {showingItem ? (
        <>
          <div className="page-head">
            <div>
              <h2>{dateFormat.format(new Date(showingItem.createdAt))}</h2>
              <p>Click a card to copy it.</p>
            </div>
            <div className="page-actions">
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => onOpenChange(null)}>
                <BackIcon />
                All drafts
              </button>
              <button className="btn btn-ghost btn-sm btn-danger" type="button" onClick={() => remove(showingItem.id)}>
                <TrashIcon />
                Delete
              </button>
            </div>
          </div>
          <div className="history-source">
            <div className="panel-header">
              <span>Screenshot summary</span>
            </div>
            <p>{showingItem.sourceText}</p>
          </div>
          <div className="tweets-grid">
            {showingItem.tweets.map((t, i) => (
              <TweetCard key={`${i}-${t.tweet}`} tweet={t} index={i} copied={copiedIndex === i} onCopy={() => copy(t.tweet, i)} />
            ))}
          </div>
        </>
      ) : openId ? (
        <p className="history-empty">Loading draft...</p>
      ) : (
        <>
          <div className="page-head">
            <div>
              <h2>History</h2>
              <p>{items ? `${items.length} ${items.length === 1 ? 'draft' : 'drafts'} · only you can see these` : 'Only you can see these.'}</p>
            </div>
            <div className="page-actions">
              <label className="search">
                <SearchIcon />
                <input type="search" placeholder="Search drafts" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search drafts" />
              </label>
            </div>
          </div>

          {filtered === null ? (
            <div className="table-skeleton" aria-label="Loading">
              <span /><span /><span /><span />
            </div>
          ) : filtered.length === 0 ? (
            <div className="history-empty">
              <p>{query ? 'No drafts match your search.' : 'No drafts yet. Generate posts from a screenshot and they will appear here.'}</p>
              {!query && (
                <button className="btn btn-primary btn-sm" type="button" onClick={onNew}>
                  <PlusIcon />
                  New post
                </button>
              )}
            </div>
          ) : (
            <div className="history-table" role="table" aria-label="Drafts">
              <div className="history-table-head" role="row">
                <span role="columnheader">Screenshot</span>
                <span role="columnheader">Created</span>
                <span role="columnheader" className="sr-only">Actions</span>
              </div>
              {filtered.map((item) => (
                <div key={item.id} className="history-row" role="row">
                  <button type="button" className="history-open" role="cell" onClick={() => onOpenChange(item.id)}>
                    <span className="history-preview">{item.preview || 'Untitled draft'}</span>
                    <span className="history-date">{dayFormat.format(new Date(item.createdAt))}</span>
                  </button>
                  <button type="button" className="history-delete" role="cell" aria-label="Delete draft" onClick={() => remove(item.id)}>
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
