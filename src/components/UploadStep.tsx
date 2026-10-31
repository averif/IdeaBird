import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { ChartIcon, CropIcon, ZoomIcon } from './icons';

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
      <div className="page-head">
        <div>
          <h2>Upload a screenshot</h2>
          <p>IdeaBird reads it, finds the story, and writes your post.</p>
        </div>
      </div>

      <div className="workspace">
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
              <p className="upload-text">Drop a screenshot here, or <span className="upload-link">browse</span></p>
              <p className="upload-subtext">You can also paste from your clipboard.</p>
            </div>
            <p className="upload-formats">PNG, JPG, WebP · up to 10 MB</p>
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

      <ul className="tips" aria-label="Tips">
        <li>
          <span className="tip-icon"><CropIcon /></span>
          <div>
            <strong>Crop to what matters</strong>
            <p>A tight crop around the key numbers or text gives sharper angles.</p>
          </div>
        </li>
        <li>
          <span className="tip-icon"><ChartIcon /></span>
          <div>
            <strong>Charts welcome</strong>
            <p>Dashboards, graphs and product UIs are read visually, not just as text.</p>
          </div>
        </li>
        <li>
          <span className="tip-icon"><ZoomIcon /></span>
          <div>
            <strong>Small print is checked</strong>
            <p>If something is hard to read, IdeaBird takes a second, closer look.</p>
          </div>
        </li>
      </ul>
    </section>
  );
}
