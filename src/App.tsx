import { useCallback, useEffect, useRef, useState } from 'react';
import Tesseract from 'tesseract.js';
import { postGenerateRequest } from './api';
import { Header } from './components/Header';
import { UploadStep } from './components/UploadStep';
import { ExtractStep, type OcrProgress } from './components/ExtractStep';
import { ResultsStep } from './components/ResultsStep';
import { GeneratingOverlay } from './components/GeneratingOverlay';
import { Toast, useToast } from './components/Toast';
import type { Step, Tweet } from './types';

const VALID_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const IDLE_OCR: OcrProgress = { active: false, percent: 0, label: 'Initializing OCR...' };

export default function App() {
  const [step, setStep] = useState<Step>('upload');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [ocr, setOcr] = useState<OcrProgress>(IDLE_OCR);
  const [tweets, setTweets] = useState<Tweet[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const { toast, showToast } = useToast();

  const generatingRef = useRef(false);
  // Bumped on every new upload / start over so a slow OCR job can't overwrite newer state.
  const ocrRunRef = useRef(0);

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

  // --- Handle File ---
  const handleFile = useCallback(
    async (file: File) => {
      if (!validateFile(file)) return;
      const run = ++ocrRunRef.current;

      replacePreview(URL.createObjectURL(file));
      goToStep('edit');
      setText('');
      setOcr({ active: true, percent: 0, label: 'Initializing OCR engine...' });

      try {
        const result = await Tesseract.recognize(file, 'eng', {
          logger: (m) => {
            if (run !== ocrRunRef.current) return;
            const percent = Math.round(m.progress * 100);
            if (m.status === 'recognizing text') {
              setOcr({ active: true, percent, label: `Recognizing text... ${percent}%` });
            } else if (m.status === 'loading language traineddata') {
              setOcr({ active: true, percent, label: `Loading language data... ${percent}%` });
            }
          },
        });
        if (run !== ocrRunRef.current) return;

        const extracted = result.data.text.trim();
        setOcr((current) => ({ ...current, active: false }));
        if (!extracted) {
          showToast('IdeaBird could not find text in this screenshot.', 'error');
          return;
        }

        setText(extracted);
      } catch (err) {
        if (run !== ocrRunRef.current) return;
        console.error('OCR error:', err);
        showToast('OCR failed. Try a cleaner image.', 'error');
        setOcr((current) => ({ ...current, active: false }));
      }
    },
    [validateFile, replacePreview, goToStep, showToast]
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
    const source = text.trim();
    if (!source || generatingRef.current) return;

    generatingRef.current = true;
    setIsGenerating(true);

    try {
      const { res, data } = await postGenerateRequest(source);

      if (!res.ok) {
        throw new Error(data.error || 'Failed to generate content');
      }

      if (data.status === 'policy_block') {
        showToast(
          data.error || 'IdeaBird cannot generate amplified versions of unverified allegations or misinformation.',
          'error',
          7000
        );
        return;
      }

      if (!Array.isArray(data.tweets)) {
        throw new Error('IdeaBird did not receive content variations from the backend.');
      }

      setTweets(data.tweets);
      goToStep('copy');
    } catch (err) {
      console.error('Generate error:', err);
      const message = err instanceof Error && err.message ? err.message : 'Failed to generate content. Please try again.';
      showToast(message, 'error', 5000);
    } finally {
      generatingRef.current = false;
      setIsGenerating(false);
    }
  }, [text, goToStep, showToast]);

  // --- Button Handlers ---
  const startOver = () => {
    ocrRunRef.current += 1;
    replacePreview(null);
    setText('');
    setTweets([]);
    setOcr(IDLE_OCR);
    goToStep('upload');
  };

  const regenerate = () => {
    goToStep('edit');
    // Small delay then auto-trigger
    setTimeout(() => generateTweets(), 100);
  };

  return (
    <div className="app">
      <Header step={step} />

      <main className="main" id="main">
        <UploadStep active={step === 'upload'} onFile={handleFile} />
        <ExtractStep
          active={step === 'edit'}
          previewUrl={previewUrl}
          text={text}
          onTextChange={setText}
          ocr={ocr}
          canGenerate={text.trim().length > 0 && !isGenerating}
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
        <GeneratingOverlay active={isGenerating} />
        <Toast toast={toast} />
      </main>
      <footer className="footer">
        <a href="/terms.html" target="_blank" rel="noreferrer">Terms</a>
      </footer>
    </div>
  );
}
