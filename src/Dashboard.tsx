import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeScreenshot, AuthRequiredError, generatePosts, refineWithOcr } from './api';
import type { AuthMode } from './auth/AuthModal';
import { apiJson } from './auth/client';
import { HistoryStep } from './components/HistoryStep';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar, type Page } from './components/Sidebar';
import { StepProgress, Topbar } from './components/Topbar';
import { UploadStep } from './components/UploadStep';
import { InsightsStep, type AnalysisStatus } from './components/InsightsStep';
import { ResultsStep } from './components/ResultsStep';
import { GeneratingOverlay } from './components/GeneratingOverlay';
import { prepareImage } from './image';
import { recognizeText } from './ocr';
import type { Analysis, HistorySummary, ToastType, Tweet } from './types';

type CreateStep = 'upload' | 'insights' | 'copy';
const PAGE_TITLES: Record<Page, string> = { create: 'Create', history: 'History', settings: 'Settings' };

const VALID_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const IDLE: AnalysisStatus = { active: false, label: '', error: null };
const POLICY_FALLBACK = 'IdeaBird cannot generate amplified versions of unverified allegations or misinformation.';
const SESSION_ENDED = 'Your session ended. Log in again to continue.';

interface DashboardProps {
  openAuth: (mode: AuthMode, reason?: string) => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

/** The signed-in app: a sidebar shell around Create (upload → insights → drafts), History and Settings. */
export default function Dashboard({ openAuth, showToast }: DashboardProps) {
  const [page, setPage] = useState<Page>('create');
  const [step, setStep] = useState<CreateStep>('upload');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [history, setHistory] = useState<HistorySummary[] | null>(null);
  const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [status, setStatus] = useState<AnalysisStatus>(IDLE);
  const [selectedAngle, setSelectedAngle] = useState<string | null>(null);
  const [tweets, setTweets] = useState<Tweet[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const generatingRef = useRef(false);
  // The current screenshot, kept for retries and the OCR fallback.
  const fileRef = useRef<File | null>(null);
  // Bumped on every new upload / start over so a slow analysis can't overwrite newer state.
  const runRef = useRef(0);

  // --- Navigation ---
  const scrollTop = () => document.querySelector('.content-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });

  const goToStep = useCallback((next: CreateStep) => {
    setPage('create');
    setStep(next);
    scrollTop();
  }, []);

  const navigate = useCallback((next: Page) => {
    setPage(next);
    if (next === 'history') setOpenHistoryId(null);
    setDrawerOpen(false);
    scrollTop();
  }, []);

  const openDraft = useCallback((id: string) => {
    setPage('history');
    setOpenHistoryId(id);
    setDrawerOpen(false);
    scrollTop();
  }, []);

  // Drafts list shared by the sidebar's Recent section and the History page.
  const loadHistory = useCallback(() => {
    apiJson<{ items: HistorySummary[] }>('/api/history')
      .then(({ items }) => setHistory(items))
      .catch(() => setHistory((current) => current ?? []));
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const replacePreview = useCallback((url: string | null) => {
    setPreviewUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return url;
    });
  }, []);

  // --- File Validation ---
  const validateFile = useCallback(
    (file: File) => {
      if (!VALID_TYPES.includes(file.type)) {
        showToast('Upload an image file: PNG, JPG, WEBP, BMP, or GIF.', 'error');
        return false;
      }
      if (file.size > MAX_FILE_SIZE) {
        showToast('That file is larger than 10MB.', 'error');
        return false;
      }
      return true;
    },
    [showToast]
  );

  // --- Analyze: vision first, OCR only if the vision model asks for it ---
  const analyze = useCallback(
    async (file: File) => {
      const run = ++runRef.current;
      const stale = () => run !== runRef.current;
      setAnalysis(null);
      setSelectedAngle(null);
      setStatus({ active: true, label: 'Reading your screenshot...', error: null });

      try {
        const result = await analyzeScreenshot(await prepareImage(file));
        if (stale()) return;

        if (result.status === 'policy_block') {
          showToast(result.error || POLICY_FALLBACK, 'error', 7000);
          setStatus(IDLE);
          goToStep('upload');
          return;
        }
        if (!result.insight || !result.insightToken) throw new Error('IdeaBird could not understand this screenshot.');

        let current: Analysis = { insight: result.insight, insightToken: result.insightToken };

        if (result.needsOcr) {
          // Vision flagged something it couldn't read reliably (tiny or dense text).
          // Recover just that with OCR and merge it in as supporting evidence.
          setStatus({ active: true, label: 'Double-checking small details...', error: null });
          const ocrText = await recognizeText(file).catch((err) => {
            console.warn('OCR fallback failed; using the visual analysis only.', err);
            return '';
          });
          if (stale()) return;
          if (ocrText) {
            const refined = await refineWithOcr(current, ocrText).catch(() => null);
            if (stale()) return;
            if (refined?.insight && refined.insightToken) current = { insight: refined.insight, insightToken: refined.insightToken };
          }
        }

        setAnalysis(current);
        setStatus(IDLE);
      } catch (err) {
        if (stale()) return;
        if (err instanceof AuthRequiredError) {
          openAuth('login', SESSION_ENDED);
          return;
        }
        console.error('Analyze error:', err);
        setStatus({ active: false, label: '', error: err instanceof Error ? err.message : 'Could not analyze this screenshot.' });
      }
    },
    [goToStep, showToast, openAuth]
  );

  // --- Handle File ---
  const handleFile = useCallback(
    (file: File) => {
      if (!validateFile(file)) return;
      fileRef.current = file;
      replacePreview(URL.createObjectURL(file));
      goToStep('insights');
      analyze(file);
    },
    [validateFile, replacePreview, goToStep, analyze]
  );

  // Paste support
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) handleFile(file);
          break;
        }
      }
    };

    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [handleFile]);

  // --- Generate Tweets ---
  const generateTweets = useCallback(async () => {
    if (!analysis || generatingRef.current) return;

    generatingRef.current = true;
    setIsGenerating(true);

    try {
      const data = await generatePosts(analysis, selectedAngle);

      if (data.status === 'policy_block') {
        showToast(data.error || POLICY_FALLBACK, 'error', 7000);
        return;
      }

      if (!Array.isArray(data.tweets)) {
        throw new Error('IdeaBird did not receive content variations from the backend.');
      }

      setTweets(data.tweets);
      goToStep('copy');
      loadHistory();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        openAuth('login', SESSION_ENDED);
        return;
      }
      console.error('Generate error:', err);
      const message = err instanceof Error && err.message ? err.message : 'Failed to generate content. Please try again.';
      showToast(message, 'error', 5000);
    } finally {
      generatingRef.current = false;
      setIsGenerating(false);
    }
  }, [analysis, selectedAngle, goToStep, showToast, openAuth, loadHistory]);

  // --- Button Handlers ---
  const startOver = () => {
    runRef.current += 1;
    fileRef.current = null;
    replacePreview(null);
    setAnalysis(null);
    setStatus(IDLE);
    setSelectedAngle(null);
    setTweets([]);
    goToStep('upload');
  };

  const retryAnalysis = () => {
    if (fileRef.current) analyze(fileRef.current);
  };

  const regenerate = () => {
    goToStep('insights');
    // Small delay then auto-trigger
    setTimeout(() => generateTweets(), 100);
  };

  const createTitleCrumb = { upload: null, insights: 'Insights', copy: 'Drafts' }[step];
  const openDraftSummary = history?.find((item) => item.id === openHistoryId);

  return (
    <div className="shell">
      <Sidebar
        page={page}
        onNavigate={navigate}
        onNewPost={() => {
          startOver();
          setDrawerOpen(false);
        }}
        recent={history}
        activeHistoryId={openHistoryId}
        onOpenRecent={openDraft}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        showToast={showToast}
      />

      <div className="shell-main">
        <Topbar
          title={PAGE_TITLES[page]}
          crumb={
            page === 'create'
              ? createTitleCrumb
              : page === 'history' && openDraftSummary
                ? new Date(openDraftSummary.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
                : null
          }
          onMenu={() => setDrawerOpen(true)}
          showPasteHint={page === 'create' && step === 'upload'}
        >
          {page === 'create' && <StepProgress step={step} />}
        </Topbar>

        <main className="content-scroll" id="main">
          <div className="content">
            <UploadStep active={page === 'create' && step === 'upload'} onFile={handleFile} />
            <InsightsStep
              active={page === 'create' && step === 'insights'}
              previewUrl={previewUrl}
              insight={analysis?.insight ?? null}
              status={status}
              selectedAngle={selectedAngle}
              onSelectAngle={setSelectedAngle}
              canGenerate={Boolean(analysis) && !status.active && !isGenerating}
              onRetry={retryAnalysis}
              onBack={() => goToStep('upload')}
              onGenerate={generateTweets}
            />
            <ResultsStep
              active={page === 'create' && step === 'copy'}
              tweets={tweets}
              isGenerating={isGenerating}
              onRegenerate={regenerate}
              onStartOver={startOver}
              showToast={showToast}
            />
            <HistoryStep
              active={page === 'history'}
              items={history}
              openId={openHistoryId}
              onOpenChange={setOpenHistoryId}
              onDeleted={(id) => setHistory((current) => current?.filter((item) => item.id !== id) ?? null)}
              onNew={startOver}
              showToast={showToast}
            />
            <SettingsPage active={page === 'settings'} draftCount={history?.length ?? null} showToast={showToast} />
          </div>
        </main>
      </div>

      <GeneratingOverlay active={isGenerating} />
    </div>
  );
}
