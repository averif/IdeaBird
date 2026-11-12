import { useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { ArticleIcon, ChartIcon, LinkIcon, MicIcon, PlayIcon, ThreadIcon } from './icons';

interface UploadStepProps {
  active: boolean;
  onFile: (file: File) => void;
  /** Returns false when the link was rejected, so the field keeps it for editing. */
  onLink: (url: string) => boolean;
}

const SOURCES = [
  { label: 'YouTube', icon: PlayIcon },
  { label: 'Podcasts', icon: MicIcon },
  { label: 'Articles & blogs', icon: ArticleIcon },
  { label: 'Newsletters', icon: ArticleIcon },
  { label: 'X posts', icon: ThreadIcon },
  { label: 'Reddit threads', icon: ThreadIcon },
];

/** Step 1 of Create: paste a link (the main way in) or drop a screenshot. */
export function UploadStep({ active, onFile, onLink }: UploadStepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState('');

  const openPicker = () => fileInputRef.current?.click();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim() && onLink(url.trim())) setUrl('');
  };

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
    if (file) return onFile(file);
    // A link dragged from another tab.
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text) onLink(text.split('\n')[0].trim());
  };

  return (
    <section className={`step step-upload${active ? ' active' : ''}`} id="step-upload">
      <div className="page-head">
        <div>
          <h2>Turn any link into posts</h2>
          <p>Paste a YouTube video, podcast, article or blog post. IdeaBird finds the ideas worth sharing and writes your posts.</p>
        </div>
      </div>

      <form className="link-box" onSubmit={submit}>
        <label className="link-field">
          <span className="link-field-icon"><LinkIcon size={18} /></span>
          <span className="sr-only">Link to turn into posts</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://youtube.com/watch?v=… or any article link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus={active}
          />
        </label>
        <button className="btn btn-primary" type="submit" disabled={!url.trim()}>
          Get insights
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
        </button>
      </form>

      <ul className="source-chips" aria-label="Works with">
        {SOURCES.map(({ label, icon: SourceIcon }) => (
          <li key={label}>
            <SourceIcon size={14} />
            {label}
          </li>
        ))}
      </ul>

      <div className="source-divider" role="separator">
        <span>or start from a screenshot</span>
      </div>

      <div
        className={`upload-zone upload-zone-compact${dragOver ? ' drag-over' : ''}`}
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
            <p className="upload-subtext">Dashboards, charts, tweets, notes. PNG, JPG, WebP up to 10 MB.</p>
          </div>
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

      <ul className="tips" aria-label="Tips">
        <li>
          <span className="tip-icon"><PlayIcon /></span>
          <div>
            <strong>Long videos welcome</strong>
            <p>Hour-long podcasts and talks are read from their captions, start to finish.</p>
          </div>
        </li>
        <li>
          <span className="tip-icon"><LinkIcon /></span>
          <div>
            <strong>Paste anywhere</strong>
            <p>Copy a link or a screenshot and press paste on this page. No need to click the box.</p>
          </div>
        </li>
        <li>
          <span className="tip-icon"><ChartIcon /></span>
          <div>
            <strong>Facts stay exact</strong>
            <p>Names, numbers and quotes are kept as the source states them. Nothing is invented.</p>
          </div>
        </li>
      </ul>
    </section>
  );
}
