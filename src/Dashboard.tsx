import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeLink, analyzeScreenshot, ApiCodeError, AuthRequiredError, expandThread, generatePosts, refineWithOcr } from './api';
import { useAuth } from './auth/AuthContext';
import type { AuthMode } from './auth/AuthModal';
import { apiJson } from './auth/client';
import { getBillingStatus, takeUpgradeIntent, useCheckoutReturn } from './billing';
import { HistoryStep } from './components/HistoryStep';
import { PlansPage } from './components/PlansPage';
import { RefinePage } from './components/RefinePage';
import { SettingsPage } from './components/SettingsPage';
import { Sidebar, type Page } from './components/Sidebar';
import { StepProgress, Topbar } from './components/Topbar';
import { UploadStep } from './components/UploadStep';
import { InsightsStep, type AnalysisStatus } from './components/InsightsStep';
import { ResultsStep } from './components/ResultsStep';
import { GeneratingOverlay } from './components/GeneratingOverlay';
import { prepareImage } from './image';
import { recognizeText } from './ocr';
import type { Analysis, HistorySummary, ToastType, Tweet, Usage } from './types';
import { useVoice } from './voice';

type CreateStep = 'upload' | 'insights' | 'copy';
const PAGE_TITLES: Record<Page, string> = { create: 'Create', refine: 'Refine', history: 'History', plans: 'Plans', settings: 'Settings' };

const VALID_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const IDLE: AnalysisStatus = { active: false, label: '', error: null };
const POLICY_FALLBACK = 'IdeaBird cannot generate amplified versions of unverified allegations or misinformation.';
const SESSION_ENDED = 'Your session ended. Log in again to continue.';
// Shown in turn while a link is read: one request, but it covers fetch, transcript and analysis.
const LINK_STEPS = ['Opening the link...', 'Reading the content...', 'Finding the ideas worth posting...', 'Picking the best angles...'];

/** The pasted text as an http(s) URL, or null. Bare domains ("example.com/post") get https://. */
function asLink(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value) || value.length > 2000) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface DashboardProps {
  openAuth: (mode: AuthMode, reason?: string) => void;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

/** The signed-in app: a sidebar shell around Create (link or screenshot → insights → drafts), History and Settings. */
export default function Dashboard({ openAuth, showToast }: DashboardProps) {
  // Arriving from the landing page's "Upgrade to Pro" opens Plans first.
  const [upgradeIntent] = useState(takeUpgradeIntent);
  const [page, setPage] = useState<Page>(upgradeIntent ? 'plans' : 'create');
  const [step, setStep] = useState<CreateStep>('upload');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [history, setHistory] = useState<HistorySummary[] | null>(null);
  // Free has no saved history (shared/plans.ts); the server says so.
  const [historyLocked, setHistoryLocked] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  // Free's separate monthly refine allowance (null on Pro).
  const [refineUsage, setRefineUsage] = useState<Usage | null>(null);
  const { user } = useAuth();
  const plan = user?.plan ?? 'free';
  const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The pasted link, when the source is a link instead of a screenshot.
  const [link, setLink] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [status, setStatus] = useState<AnalysisStatus>(IDLE);
  const [selectedAngle, setSelectedAngle] = useState<string | null>(null);
  const [tweets, setTweets] = useState<Tweet[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  // The saved generation behind the current drafts (Pro), so expansions join it in History.
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [expandingIndex, setExpandingIndex] = useState<number | null>(null);

  const generatingRef = useRef(false);
  // The current screenshot, kept for retries and the OCR fallback.
  const fileRef = useRef<File | null>(null);
  // The current link, kept for retries.
  const linkRef = useRef<string | null>(null);
  // Bumped on every new upload / start over so a slow analysis can't overwrite newer state.
  const runRef = useRef(0);

  // Back from Dodo checkout: confirm the subscription, then show Plans.
  useCheckoutReturn(showToast, () => setPage('plans'));

  // Write Like Me. Arriving back from X opens Settings, where the voice is learned.
  const voice = useVoice(showToast, () => setPage('settings'));

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
    apiJson<{ items: HistorySummary[]; locked?: boolean }>('/api/history')
      .then(({ items, locked }) => {
        setHistory(items);
        setHistoryLocked(Boolean(locked));
      })
      .catch(() => setHistory((current) => current ?? []));
  }, []);

  useEffect(() => {
    loadHistory();
    getBillingStatus()
      .then((billing) => {
        setUsage(billing.usage);
        setRefineUsage(billing.refines ?? null);
      })
      .catch(() => {});
    // Reload when the plan changes (e.g. right after upgrading).
  }, [loadHistory, plan]);

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

  // --- Analyze a link: the server reads the page or transcript ---
  const analyzeUrl = useCallback(
    async (url: string) => {
      const run = ++runRef.current;
      const stale = () => run !== runRef.current;
      setAnalysis(null);
      setSelectedAngle(null);
      let stepIndex = 0;
      setStatus({ active: true, label: LINK_STEPS[0], error: null });
      const ticker = window.setInterval(() => {
        stepIndex = Math.min(stepIndex + 1, LINK_STEPS.length - 1);
        if (!stale()) setStatus({ active: true, label: LINK_STEPS[stepIndex], error: null });
      }, 4000);

      try {
        const result = await analyzeLink(url);
        if (stale()) return;
        if (result.status === 'policy_block') {
          showToast(result.error || POLICY_FALLBACK, 'error', 7000);
          setStatus(IDLE);
          goToStep('upload');
          return;
        }
        if (!result.insight || !result.insightToken) throw new Error('IdeaBird could not understand this link.');
        setAnalysis({ insight: result.insight, insightToken: result.insightToken });
        setStatus(IDLE);
      } catch (err) {
        if (stale()) return;
        if (err instanceof AuthRequiredError) {
          openAuth('login', SESSION_ENDED);
          return;
        }
        console.error('Link error:', err);
        setStatus({ active: false, label: '', error: err instanceof Error ? err.message : 'Could not read this link.' });
      } finally {
        window.clearInterval(ticker);
      }
    },
    [goToStep, showToast, openAuth]
  );

  const handleLink = useCallback(
    (text: string) => {
      const url = asLink(text);
      if (!url) {
        showToast("That doesn't look like a link. Paste the full address, starting with https://", 'error');
        return false;
      }
      fileRef.current = null;
      linkRef.current = url;
      replacePreview(null);
      setLink(url);
      goToStep('insights');
      analyzeUrl(url);
      return true;
    },
    [showToast, replacePreview, goToStep, analyzeUrl]
  );

  // --- Handle File ---
  const handleFile = useCallback(
    (file: File) => {
      if (!validateFile(file)) return;
      fileRef.current = file;
      linkRef.current = null;
      setLink(null);
      replacePreview(URL.createObjectURL(file));
      goToStep('insights');
      analyze(file);
    },
    [validateFile, replacePreview, goToStep, analyze]
  );

  // Paste support: a screenshot anywhere, or a link anywhere on the first step.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) handleFile(file);
          return;
        }
      }
      // Text pasted into a field (the link box, Refine, Settings) is left to that field.
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (page !== 'create' || step !== 'upload') return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (asLink(text)) {
        e.preventDefault();
        handleLink(text);
      }
    };

    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [handleFile, handleLink, page, step]);

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
      setGenerationId(data.id ?? null);
      if (data.usage) setUsage(data.usage);
      goToStep('copy');
      loadHistory();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        openAuth('login', SESSION_ENDED);
        return;
      }
      if (err instanceof ApiCodeError && err.code === 'limit_reached') {
        // Out of generations this month: show what Pro offers.
        showToast(err.message, 'error', 8000);
        setPage('plans');
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

  // --- Thread expansion (Pro) ---
  const expandIntoThread = useCallback(
    async (index: number) => {
      const source = tweets[index];
      if (!analysis || !source || expandingIndex !== null) return;
      setExpandingIndex(index);
      try {
        const data = await expandThread(analysis, source.tweet, generationId);
        if (!data.tweet) throw new Error('IdeaBird did not receive a thread.');
        const thread = data.tweet;
        // Show it right after the post it came from.
        setTweets((current) => [...current.slice(0, index + 1), thread, ...current.slice(index + 1)]);
        if (data.usage) setUsage(data.usage);
        showToast('Thread ready. Click it to copy.', 'success');
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          openAuth('login', SESSION_ENDED);
          return;
        }
        if (err instanceof ApiCodeError && err.code === 'limit_reached') {
          showToast(err.message, 'error', 8000);
          setPage('plans');
          return;
        }
        showToast(err instanceof Error ? err.message : 'Could not write the thread. Please try again.', 'error', 6000);
      } finally {
        setExpandingIndex(null);
      }
    },
    [tweets, analysis, generationId, expandingIndex, showToast, openAuth]
  );

  // --- Button Handlers ---
  const startOver = () => {
    runRef.current += 1;
    fileRef.current = null;
    linkRef.current = null;
    setLink(null);
    replacePreview(null);
    setAnalysis(null);
    setStatus(IDLE);
    setSelectedAngle(null);
    setTweets([]);
    goToStep('upload');
  };

  const retryAnalysis = () => {
    if (linkRef.current) analyzeUrl(linkRef.current);
    else if (fileRef.current) analyze(fileRef.current);
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
        recentLocked={historyLocked}
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
            <UploadStep active={page === 'create' && step === 'upload'} onFile={handleFile} onLink={handleLink} />
            <InsightsStep
              active={page === 'create' && step === 'insights'}
              previewUrl={previewUrl}
              link={link}
              insight={analysis?.insight ?? null}
              status={status}
              selectedAngle={selectedAngle}
              onSelectAngle={setSelectedAngle}
              canGenerate={Boolean(analysis) && !status.active && !isGenerating}
              onRetry={retryAnalysis}
              onBack={() => goToStep('upload')}
              onGenerate={generateTweets}
              voice={voice}
              usageNote={
                plan === 'free' && usage
                  ? `${Math.max(0, usage.limit - usage.used)} of ${usage.limit} free generations left this month`
                  : null
              }
            />
            <ResultsStep
              active={page === 'create' && step === 'copy'}
              tweets={tweets}
              isGenerating={isGenerating}
              onRegenerate={regenerate}
              onStartOver={startOver}
              showToast={showToast}
              onUpgrade={plan === 'free' ? () => navigate('plans') : undefined}
              onExpand={expandIntoThread}
              expandLocked={plan === 'free'}
              expandingIndex={expandingIndex}
            />
            <RefinePage
              active={page === 'refine'}
              isPro={plan === 'pro'}
              usage={usage}
              onUsage={setUsage}
              refineUsage={refineUsage}
              onRefineUsage={setRefineUsage}
              onUpgrade={() => navigate('plans')}
              onAuthRequired={() => openAuth('login', SESSION_ENDED)}
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
              locked={historyLocked}
              onUpgrade={() => navigate('plans')}
            />
            <PlansPage active={page === 'plans'} initialInterval={upgradeIntent ?? undefined} onNavigate={navigate} showToast={showToast} />
            <SettingsPage active={page === 'settings'} draftCount={history?.length ?? null} voice={voice} onUpgrade={() => navigate('plans')} showToast={showToast} />
          </div>
        </main>
      </div>

      <GeneratingOverlay active={isGenerating} />
    </div>
  );
}
