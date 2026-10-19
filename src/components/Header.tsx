import type { Step } from '../types';

export function Header({ step }: { step: Step }) {
  return (
    <header className="header" id="header">
      <div className="header-inner">
        <a className="brand" href="#step-upload" aria-label="IdeaBird home">
          <span className="brand-mark" aria-hidden="true">
            <img src="/IdeaBird.png" alt="" />
          </span>
          <span className="brand-name">IdeaBird</span>
        </a>
        <div className="header-status" id="workflow-status" data-step={step} aria-label="Workflow">
          <span data-step-label="upload">01 Upload</span>
          <span data-step-label="edit">02 Edit</span>
          <span data-step-label="copy">03 Copy</span>
        </div>
      </div>
    </header>
  );
}
