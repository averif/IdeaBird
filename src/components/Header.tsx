import type { ReactNode } from 'react';
import type { Step } from '../types';
import { BrandMark } from './BrandMark';

export function Header({ step, onHome, children }: { step: Step; onHome: () => void; children?: ReactNode }) {
  return (
    <header className="header" id="header">
      <div className="header-inner">
        <button className="brand" type="button" onClick={onHome} aria-label="IdeaBird home">
          <BrandMark />
          <span className="brand-name">IdeaBird</span>
        </button>
        <div className="header-status" id="workflow-status" data-step={step} aria-label="Workflow">
          <span data-step-label="upload">01 Upload</span>
          <span data-step-label="insights">02 Insights</span>
          <span data-step-label="copy">03 Copy</span>
        </div>
        {children}
      </div>
    </header>
  );
}
