import type { InsightSource, ScreenshotInsight } from '../types';
import { ArticleIcon, PlayIcon, ThreadIcon } from './icons';
import type { VoiceControls } from '../voice';
import { VoiceToggle } from './WriteLikeMe';

export interface AnalysisStatus {
  active: boolean;
  label: string;
  error: string | null;
}

interface InsightsStepProps {
  active: boolean;
  previewUrl: string | null;
  /** The pasted link being read, when the source is a link rather than a screenshot. */
  link: string | null;
  insight: ScreenshotInsight | null;
  status: AnalysisStatus;
  selectedAngle: string | null;
  onSelectAngle: (angle: string | null) => void;
  canGenerate: boolean;
  onRetry: () => void;
  onBack: () => void;
  onGenerate: () => void;
  voice: VoiceControls;
  /** e.g. "7 of 10 free generations left this month". */
  usageNote?: string | null;
}

export function InsightsStep({
  active,
  previewUrl,
  link,
  insight,
  status,
  selectedAngle,
  onSelectAngle,
  canGenerate,
  onRetry,
  onBack,
  onGenerate,
  voice,
  usageNote = null,
}: InsightsStepProps) {
  const facts = insight ? [...insight.keyFacts, ...insight.notablePoints] : [];

  return (
    <section className={`step step-insights${active ? ' active' : ''}`} id="step-insights">
      <div className="page-head">
        <div>
          <h2>Insights</h2>
          <p>What IdeaBird found{link ? ' in the link' : ''}. Pick an angle, or let it choose.</p>
        </div>
      </div>

      <div className="extract-layout">
        {link ? (
          <LinkCard url={link} source={insight?.source ?? null} loading={status.active} />
        ) : (
          <div className="preview-card">
            <div className="panel-header">
              <span>Screenshot</span>
              <span className="panel-meta">source</span>
            </div>
            <div className="preview-frame">
              <img id="preview-image" src={previewUrl ?? undefined} alt="Uploaded screenshot" />
            </div>
          </div>
        )}

        <div className="insight-card" aria-live="polite" aria-busy={status.active}>
          <div className="panel-header">
            <span>What IdeaBird sees</span>
            {insight && <span className="panel-meta">{insight.metrics.length ? `${insight.metrics.length} metrics` : 'analyzed'}</span>}
          </div>

          {status.active ? (
            <div className="insight-loading">
              <div className="insight-progress" />
              <p>{status.label}</p>
              <div className="skeleton-lines" aria-hidden="true">
                <span /><span /><span />
              </div>
            </div>
          ) : status.error ? (
            <div className="insight-loading">
              <p className="form-error" role="alert">{status.error}</p>
              <button className="btn btn-ghost btn-sm" type="button" onClick={onRetry}>Try again</button>
            </div>
          ) : insight ? (
            <div className="insight-body">
              <p className="insight-summary">{insight.summary}</p>

              {insight.metrics.length > 0 && (
                <div className="metric-grid">
                  {insight.metrics.map((metric) => (
                    <div className="metric" key={`${metric.label}-${metric.value}`}>
                      <span className="metric-label">{metric.label}</span>
                      <span className="metric-value">{metric.value}</span>
                      {metric.context && <span className="metric-context">{metric.context}</span>}
                    </div>
                  ))}
                </div>
              )}

              {facts.length > 0 && (
                <div className="insight-section">
                  <h3>Key insights</h3>
                  <ul>
                    {facts.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                </div>
              )}

              {insight.possibleStories.length > 0 && (
                <div className="insight-section">
                  <h3>Possible stories</h3>
                  <div className="chip-row">
                    {insight.possibleStories.map((story) => (
                      <span className="chip chip-static" key={story}>{story}</span>
                    ))}
                  </div>
                </div>
              )}

              {insight.contentAngles.length > 0 && (
                <div className="insight-section">
                  <h3>Angle</h3>
                  <div className="chip-row" role="radiogroup" aria-label="Content angle">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selectedAngle === null}
                      className={`chip${selectedAngle === null ? ' selected' : ''}`}
                      onClick={() => onSelectAngle(null)}
                    >
                      Let IdeaBird choose
                    </button>
                    {insight.contentAngles.map((angle) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selectedAngle === angle}
                        className={`chip${selectedAngle === angle ? ' selected' : ''}`}
                        key={angle}
                        onClick={() => onSelectAngle(angle)}
                      >
                        {angle}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {insight.uncertainties.length > 0 && (
                <p className="insight-note">Couldn't read clearly: {insight.uncertainties.join('; ')}. These won't be stated as fact.</p>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="step-actions">
        <button className="btn btn-ghost" id="btn-back-upload" type="button" onClick={onBack}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          Back
        </button>
        <div className="step-actions-end">
          {usageNote && <span className="usage-note">{usageNote}</span>}
          <VoiceToggle controls={voice} />
          <button className="btn btn-primary" id="btn-generate" type="button" disabled={!canGenerate} onClick={onGenerate}>
            Generate posts
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
          </button>
        </div>
      </div>
    </section>
  );
}

const KIND_LABELS: Record<InsightSource['kind'], string> = {
  youtube: 'YouTube video',
  article: 'Article',
  x: 'X post',
  reddit: 'Reddit thread',
};

function youtubeThumbnail(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get('v');
    return id && /^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The pasted link: what it is, who made it, and a way back to it. */
function LinkCard({ url, source, loading }: { url: string; source: InsightSource | null; loading: boolean }) {
  const kind = source?.kind;
  const KindIcon = kind === 'youtube' ? PlayIcon : kind === 'x' || kind === 'reddit' ? ThreadIcon : ArticleIcon;
  const thumbnail = kind === 'youtube' && source ? youtubeThumbnail(source.url) : null;
  const byline = [source?.author, source?.siteName && source.siteName !== source.author ? source.siteName : null].filter(Boolean).join(' · ');

  return (
    <div className="preview-card link-card">
      <div className="panel-header">
        <span>Link</span>
        <span className="panel-meta">{kind ? KIND_LABELS[kind].toLowerCase() : 'source'}</span>
      </div>
      <div className="link-card-body">
        {thumbnail && <img className="link-thumb" src={thumbnail} alt="" loading="lazy" />}
        <span className="link-kind">
          <KindIcon size={14} />
          {kind ? KIND_LABELS[kind] : loading ? 'Reading…' : 'Link'}
        </span>
        {source ? (
          <>
            <h3 className="link-title">{source.title}</h3>
            {byline && <p className="link-byline">{byline}</p>}
          </>
        ) : (
          <div className="skeleton-lines" aria-hidden="true">
            <span /><span />
          </div>
        )}
        <a className="link-url" href={source?.url ?? url} target="_blank" rel="noreferrer noopener">
          {hostOf(source?.url ?? url)}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7" /><path d="M8 7h9v9" /></svg>
        </a>
        {source?.note && <p className="insight-note">{source.note}</p>}
      </div>
    </div>
  );
}
