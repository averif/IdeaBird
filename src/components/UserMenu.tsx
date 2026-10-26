import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { ToastType } from '../types';

interface UserMenuProps {
  onHistory: () => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

export function UserMenu({ onHistory, showToast }: UserMenuProps) {
  const { status, user, logout, logoutEverywhere } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (status !== 'authenticated' || !user) return <div className="user-area" aria-hidden="true" />;

  const act = (action: () => Promise<unknown>, success: string) => async () => {
    setOpen(false);
    try {
      await action();
      showToast(success, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    }
  };

  const initial = (user.name || user.email).trim().charAt(0).toUpperCase();

  return (
    <div className="user-area" ref={menuRef}>
      <button className="btn btn-ghost btn-sm" type="button" onClick={onHistory}>History</button>
      <button
        className="avatar-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        {initial}
      </button>

      {open && (
        <div className="menu" role="menu">
          <div className="menu-identity">
            {user.name && <strong>{user.name}</strong>}
            <span>{user.email}</span>
          </div>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onHistory(); }}>History</button>
          <button type="button" role="menuitem" onClick={act(logout, 'Logged out.')}>Log out</button>
          <button type="button" role="menuitem" onClick={act(logoutEverywhere, 'Logged out on all devices.')}>
            Log out of all devices
          </button>
        </div>
      )}
    </div>
  );
}
