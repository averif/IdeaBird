import type { CSSProperties } from 'react';

export interface OcrProgress {
  active: boolean;
  percent: number;
  label: string;
}

interface ExtractStepProps {
  active: boolean;
  previewUrl: string | null;
  text: string;
  onTextChange: (text: string) => void;
  ocr: OcrProgress;
  canGenerate: boolean;
  onBack: () => void;
  onGenerate: () => void;
}

export function ExtractStep({
  active,
  previewUrl,
  text,
  onTextChange,
  ocr,
  canGenerate,
  onBack,
  onGenerate,
}: ExtractStepProps) {
  return (
    <section className={`step step-extract${active ? ' active' : ''}`} id="step-extract">
      <div className="step-header compact">
        <span className="eyebrow">Edit source</span>
        <h2>Clean the text.</h2>
        <p className="step-desc">Fix OCR mistakes before generating.</p>
      </div>

      <div className="extract-layout">
        <div className="preview-card">
          <div className="panel-header">
            <span>Screenshot</span>
            <span className="panel-meta">source</span>
          </div>
          <div className="preview-frame">
            <img id="preview-image" src={previewUrl ?? undefined} alt="Uploaded screenshot" />
          </div>
        </div>

        <div className="text-card">
          <div className="panel-header">
            <span>Text</span>
            <span className="char-count" id="char-count">{text.length} chars</span>
          </div>
          <textarea
            id="extracted-text"
            placeholder="Extracting text..."
            rows={10}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
          />
          <div className={`ocr-progress${ocr.active ? ' active' : ''}`} id="ocr-progress">
            <div
              className="ocr-progress-bar"
              id="ocr-progress-bar"
              style={{ '--progress': `${ocr.percent}%` } as CSSProperties}
            />
            <span className="ocr-progress-text" id="ocr-progress-text">{ocr.label}</span>
          </div>
        </div>
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" id="btn-back-upload" type="button" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          Back
        </button>
        <button className="btn btn-primary" id="btn-generate" type="button" disabled={!canGenerate} onClick={onGenerate}>
          Generate posts
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
        </button>
      </div>
    </section>
  );
}
