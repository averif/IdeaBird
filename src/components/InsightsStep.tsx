import type { ScreenshotInsight } from '../types';
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
  insight: ScreenshotInsight | null;
  status: AnalysisStatus;
  selectedAngle: string | null;
  onSelectAngle: (angle: string | null) => void;
  canGenerate: boolean;
  onRetry: () => void;
  onBack: () => void;
  onGenerate: () => void;
  voice: VoiceControls;
}

export function InsightsStep({
  active,
  previewUrl,
  insight,
  status,
  selectedAngle,
  onSelectAngle,
  canGenerate,
  onRetry,
  onBack,
  onGenerate,
  voice,
}: InsightsStepProps) {
  const facts = insight ? [...insight.keyFacts, ...insight.notablePoints] : [];

  return (
    <section className={`step step-insights${active ? ' active' : ''}`} id="step-insights">
      <div className="page-head">
        <div>
          <h2>Insights</h2>
          <p>What IdeaBird found. Pick an angle, or let it choose.</p>
        </div>
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
