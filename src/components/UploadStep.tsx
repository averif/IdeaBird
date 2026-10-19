import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

interface UploadStepProps {
  active: boolean;
  onFile: (file: File) => void;
}

export function UploadStep({ active, onFile }: UploadStepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const openPicker = () => fileInputRef.current?.click();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  };

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  return (
    <section className={`step step-upload${active ? ' active' : ''}`} id="step-upload">
      <div className="workspace">
        <div className="workspace-copy">
          <span className="eyebrow">Screenshot to posts</span>
          <h1>Turn screenshots into publish-ready posts.</h1>
          <p className="step-desc">Minimal OCR-to-post studio for quick, human-sounding output.</p>
        </div>

        <div
          className={`upload-zone${dragOver ? ' drag-over' : ''}`}
          id="upload-zone"
          tabIndex={0}
          role="button"
          aria-label="Upload screenshot"
          onClick={openPicker}
          onKeyDown={onKeyDown}
          onDragEnter={onDragEnter}
          onDragOver={onDragEnter}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div className="upload-zone-content">
            <div className="upload-icon" aria-hidden="true">
              <img src="/upload.png" alt="" />
            </div>
            <div>
              <p className="upload-text">Upload screenshot</p>
              <p className="upload-subtext">Drag, paste, or browse.</p>
            </div>
            <p className="upload-formats">PNG / JPG / WEBP</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            id="file-input"
            accept="image/*"
            hidden
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset so picking the same file again still fires change.
              e.target.value = '';
              if (file) onFile(file);
            }}
          />
        </div>
      </div>

      <aside className="signal-panel" aria-label="Output overview">
        <span>5 outputs</span>
        <span>OCR</span>
        <span>Posts + thread</span>
      </aside>
    </section>
  );
}
