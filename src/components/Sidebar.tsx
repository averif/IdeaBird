import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { HistorySummary, ToastType } from '../types';
import { BrandMark } from './BrandMark';
import {
  ChevronIcon,
  CloseIcon,
  CreateIcon,
  DevicesIcon,
  HelpIcon,
  HistoryIcon,
  LogOutIcon,
  PlusIcon,
  RefineIcon,
  SettingsIcon,
  SparkIcon,
} from './icons';

export type Page = 'create' | 'refine' | 'history' | 'plans' | 'settings';

interface SidebarProps {
  page: Page;
  onNavigate: (page: Page) => void;
  onNewPost: () => void;
  recent: HistorySummary[] | null;
  /** Free plan: no saved drafts. */
  recentLocked?: boolean;
  activeHistoryId: string | null;
  onOpenRecent: (id: string) => void;
  /** Mobile drawer state; ignored on wide screens where the sidebar is always shown. */
  open: boolean;
  onClose: () => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const NAV: { page: Page; label: string; icon: () => JSX.Element }[] = [
  { page: 'create', label: 'Create', icon: CreateIcon },
  { page: 'refine', label: 'Refine', icon: RefineIcon },
  { page: 'history', label: 'History', icon: HistoryIcon },
  { page: 'plans', label: 'Plans', icon: SparkIcon },
  { page: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar({
  page,
  onNavigate,
  onNewPost,
  recent,
  recentLocked = false,
  activeHistoryId,
  onOpenRecent,
  open,
  onClose,
  showToast,
}: SidebarProps) {
  const { user, logout, logoutEverywhere } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const act = (action: () => Promise<unknown>, success: string) => async () => {
    setMenuOpen(false);
    try {
      await action();
      showToast(success, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    }
  };

  const displayName = user?.name || user?.email.split('@')[0] || '';
  const initial = (user?.name || user?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <>
      <div className={`sidebar-scrim${open ? ' open' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Main navigation">
        <div className="sidebar-top">
          <button className="sidebar-brand" type="button" onClick={onNewPost} aria-label="IdeaBird home">
            <BrandMark size={28} />
            <span>IdeaBird</span>
          </button>
          <button className="icon-button sidebar-close" type="button" onClick={onClose} aria-label="Close menu">
            <CloseIcon />
          </button>
        </div>

        <button className="new-post" type="button" onClick={onNewPost}>
          <PlusIcon />
          New post
        </button>

        <nav className="sidebar-nav">
          {NAV.map(({ page: target, label, icon: NavIcon }) => (
            <button
              key={target}
              type="button"
              className={`nav-item${page === target ? ' active' : ''}`}
              aria-current={page === target ? 'page' : undefined}
              onClick={() => onNavigate(target)}
            >
              <NavIcon />
              <span>{label}</span>
              {target === 'history' && recent && recent.length > 0 && <span className="nav-count">{recent.length}</span>}
              {target === 'plans' && user?.plan === 'pro' && <span className="nav-pro">Pro</span>}
              {target === 'refine' && user?.plan !== 'pro' && <span className="nav-pro nav-pro-muted">Pro</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-section">
          <p className="sidebar-label">Recent</p>
          {recent === null ? (
            <div className="recent-skeleton" aria-hidden="true">
              <span /><span /><span />
            </div>
          ) : recent.length === 0 ? (
            <p className="recent-empty">{recentLocked ? 'Saved drafts come with Pro.' : 'Your drafts will show up here.'}</p>
          ) : (
            <ul className="recent-list">
              {recent.slice(0, 8).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`recent-item${activeHistoryId === item.id && page === 'history' ? ' active' : ''}`}
                    title={item.preview}
                    onClick={() => onOpenRecent(item.id)}
                  >
                    {item.preview || 'Untitled draft'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="sidebar-bottom">
          <a className="nav-item subtle" href="/terms.html" target="_blank" rel="noreferrer">
            <HelpIcon />
            <span>Terms &amp; help</span>
          </a>

          <div className="account" ref={accountRef}>
            {menuOpen && (
              <div className="account-menu" role="menu">
                <div className="account-menu-identity">
                  <strong>{displayName}</strong>
                  <span>{user?.email}</span>
                </div>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onNavigate('settings'); }}>
                  <SettingsIcon />
                  Settings
                </button>
                <button type="button" role="menuitem" onClick={act(logoutEverywhere, 'Logged out on all devices.')}>
                  <DevicesIcon />
                  Log out of all devices
                </button>
                <button type="button" role="menuitem" onClick={act(logout, 'Logged out.')}>
                  <LogOutIcon />
                  Log out
                </button>
              </div>
            )}
            <button
              className={`account-button${menuOpen ? ' open' : ''}`}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <span className="avatar" aria-hidden="true">{initial}</span>
              <span className="account-text">
                <strong>{displayName}</strong>
                <span>{user?.email}</span>
              </span>
              <ChevronIcon />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
