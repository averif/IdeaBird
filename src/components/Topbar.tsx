import type { ReactNode } from 'react';
import { MenuIcon } from './icons';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);

interface TopbarProps {
  title: string;
  /** Optional secondary crumb, e.g. the open draft's date. */
  crumb?: string | null;
  onMenu: () => void;
  /** Centre slot (the step progress on Create). */
  children?: ReactNode;
  showPasteHint?: boolean;
}

export function Topbar({ title, crumb, onMenu, children, showPasteHint }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-button topbar-menu" type="button" onClick={onMenu} aria-label="Open menu">
          <MenuIcon />
        </button>
        <h1 className="topbar-title">
          {title}
          {crumb && (
            <>
              <span className="crumb-sep" aria-hidden="true">/</span>
              <span className="crumb">{crumb}</span>
            </>
          )}
        </h1>
      </div>
      <div className="topbar-center">{children}</div>
      <div className="topbar-right">
        {showPasteHint && (
          <span className="kbd-hint">
            <kbd>{IS_MAC ? '⌘' : 'Ctrl'}</kbd>
            <kbd>V</kbd>
            to paste
          </span>
        )}
      </div>
    </header>
  );
}

/** The 3-step progress shown on Create. */
export function StepProgress({ step }: { step: 'upload' | 'insights' | 'copy' }) {
  const steps = [
    { id: 'upload', label: 'Upload' },
    { id: 'insights', label: 'Insights' },
    { id: 'copy', label: 'Drafts' },
  ] as const;
  const current = steps.findIndex((s) => s.id === step);
  return (
    <ol className="progress" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.id} className={i < current ? 'done' : i === current ? 'current' : undefined} aria-current={i === current ? 'step' : undefined}>
          <span className="progress-dot">{i < current ? '✓' : i + 1}</span>
          <span className="progress-label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}
