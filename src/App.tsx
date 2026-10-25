import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeScreenshot, AuthRequiredError, generatePosts, refineWithOcr } from './api';
import { useAuth } from './auth/AuthContext';
import { AuthModal, type AuthMode } from './auth/AuthModal';
import { Header } from './components/Header';
import { HistoryStep } from './components/HistoryStep';
import { UserMenu } from './components/UserMenu';
import { UploadStep } from './components/UploadStep';
import { InsightsStep, type AnalysisStatus } from './components/InsightsStep';
import { ResultsStep } from './components/ResultsStep';
import { GeneratingOverlay } from './components/GeneratingOverlay';
import { Toast, useToast } from './components/Toast';
import { prepareImage } from './image';
import { recognizeText } from './ocr';
import type { Analysis, Step, Tweet } from './types';

const VALID_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const IDLE: AnalysisStatus = { active: false, label: '', error: null };
const POLICY_FALLBACK = 'IdeaBird cannot generate amplified versions of unverified allegations or misinformation.';

export default function App() {
  const [step, setStep] = useState<Step>('upload');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [status, setStatus] = useState<AnalysisStatus>(IDLE);
  const [selectedAngle, setSelectedAngle] = useState<string | null>(null);
  const [tweets, setTweets] = useState<Tweet[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast, showToast } = useToast();
  const auth = useAuth();
  const [authModal, setAuthModal] = useState<{ mode: AuthMode; reason?: string } | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);

  const generatingRef = useRef(false);
  // Work interrupted by the login prompt; it resumes after login.
  const pendingGenerateRef = useRef(false);
  const pendingFileRef = useRef<File | null>(null);
  // The current screenshot, kept for retries and the OCR fallback.
  const fileRef = useRef<File | null>(null);
  // Bumped on every new upload / start over so a slow analysis can't overwrite newer state.
  const runRef = useRef(0);

  // --- Step Navigation ---
  const goToStep = useCallback((next: Step) => {
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

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
          pendingFileRef.current = file;
          setStatus(IDLE);
          setAuthModal({ mode: 'login', reason: 'Your session ended. Log in again to continue.' });
          return;
        }
        console.error('Analyze error:', err);
        setStatus({ active: false, label: '', error: err instanceof Error ? err.message : 'Could not analyze this screenshot.' });
      }
    },
    [goToStep, showToast]
  );

  // --- Handle File ---
  const handleFile = useCallback(
    (file: File) => {
      if (!validateFile(file)) return;

      // Analysis runs on our servers, so it needs an account.
      if (auth.status !== 'authenticated') {
        pendingFileRef.current = file;
        setAuthModal({ mode: 'signup', reason: 'Sign up or log in so IdeaBird can read your screenshot.' });
        return;
      }

      fileRef.current = file;
      replacePreview(URL.createObjectURL(file));
      goToStep('insights');
      analyze(file);
    },
    [validateFile, auth.status, replacePreview, goToStep, analyze]
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

    if (auth.status !== 'authenticated') {
      pendingGenerateRef.current = true;
      setAuthModal({ mode: 'login', reason: 'Log in to generate posts.' });
      return;
    }

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
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        pendingGenerateRef.current = true;
        setAuthModal({ mode: 'login', reason: 'Your session ended. Log in again to generate.' });
        return;
      }
      console.error('Generate error:', err);
      const message = err instanceof Error && err.message ? err.message : 'Failed to generate content. Please try again.';
      showToast(message, 'error', 5000);
    } finally {
      generatingRef.current = false;
      setIsGenerating(false);
    }
  }, [analysis, selectedAngle, auth.status, goToStep, showToast]);

  // Resume work that was interrupted by the login prompt.
  useEffect(() => {
    if (auth.status !== 'authenticated' || authModal) return;
    if (pendingFileRef.current) {
      const file = pendingFileRef.current;
      pendingFileRef.current = null;
      handleFile(file);
    } else if (pendingGenerateRef.current) {
      pendingGenerateRef.current = false;
      generateTweets();
    }
  }, [auth.status, authModal, handleFile, generateTweets]);

  // History is private: leave it as soon as the session ends.
  useEffect(() => {
    if (auth.status === 'anonymous' && step === 'history') goToStep('upload');
  }, [auth.status, step, goToStep]);

  // Email links land on /?verify=<token> or /?reset=<token>. Strip the token from
  // the address bar (and so from history and Referer headers) right away.
  const handledLinkRef = useRef(false);
  useEffect(() => {
    if (handledLinkRef.current) return;
    handledLinkRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const verify = params.get('verify');
    const reset = params.get('reset');
    if (!verify && !reset) return;
    window.history.replaceState(null, '', window.location.pathname);

    if (reset) {
      setResetToken(reset);
      setAuthModal({ mode: 'reset' });
    } else if (verify) {
      auth
        .verifyEmail(verify)
        .then(() => showToast('Email verified. Thanks!', 'success'))
        .catch((err: Error) => showToast(err.message, 'error', 5000));
    }
  }, [auth, showToast]);

  const closeAuthModal = useCallback(() => {
    pendingGenerateRef.current = false;
    pendingFileRef.current = null;
    setAuthModal(null);
  }, []);

  const onAuthenticated = useCallback(() => {
    setAuthModal(null);
    setResetToken(null);
    if (!pendingGenerateRef.current && !pendingFileRef.current) showToast('You are logged in.', 'success');
  }, [showToast]);

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

  return (
    <div className="app">
      <Header step={step}>
        <UserMenu
          onLogin={() => setAuthModal({ mode: 'login' })}
          onSignup={() => setAuthModal({ mode: 'signup' })}
          onHistory={() => goToStep('history')}
          showToast={showToast}
        />
      </Header>

      <main className="main" id="main">
        <UploadStep active={step === 'upload'} onFile={handleFile} />
        <InsightsStep
          active={step === 'insights'}
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
          active={step === 'copy'}
          tweets={tweets}
          isGenerating={isGenerating}
          onRegenerate={regenerate}
          onStartOver={startOver}
          showToast={showToast}
        />
        {auth.status === 'authenticated' && (
          <HistoryStep active={step === 'history'} onNew={startOver} showToast={showToast} />
        )}
        <GeneratingOverlay active={isGenerating} />
        <Toast toast={toast} />
      </main>
      {authModal && (
        <AuthModal
          mode={authModal.mode}
          reason={authModal.reason}
          resetToken={resetToken}
          onModeChange={(mode) => setAuthModal((current) => ({ ...current, mode }))}
          onClose={closeAuthModal}
          onAuthenticated={onAuthenticated}
        />
      )}
      <footer className="footer">
        <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a>
      </footer>
    </div>
  );
}
