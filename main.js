import Tesseract from 'tesseract.js';

// --- DOM Refs ---
const stepUpload = document.getElementById('step-upload');
const stepExtract = document.getElementById('step-extract');
const stepResults = document.getElementById('step-results');
const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const previewImage = document.getElementById('preview-image');
const extractedText = document.getElementById('extracted-text');
const charCount = document.getElementById('char-count');
const ocrProgress = document.getElementById('ocr-progress');
const ocrProgressBar = document.getElementById('ocr-progress-bar');
const ocrProgressText = document.getElementById('ocr-progress-text');
const btnGenerate = document.getElementById('btn-generate');
const btnBackUpload = document.getElementById('btn-back-upload');
const btnStartOver = document.getElementById('btn-start-over');
const btnRegenerate = document.getElementById('btn-regenerate');
const tweetsGrid = document.getElementById('tweets-grid');
const generatingOverlay = document.getElementById('generating-overlay');
const toast = document.getElementById('toast');
const workflowStatus = document.getElementById('workflow-status');

// --- State ---
let currentFile = null;
let isGenerating = false;

// --- Step Navigation ---
function getWorkflowStep(step) {
  if (step === stepExtract) return 'edit';
  if (step === stepResults) return 'copy';
  return 'upload';
}

function goToStep(step) {
  [stepUpload, stepExtract, stepResults].forEach(s => s.classList.remove('active'));
  step.classList.add('active');
  workflowStatus.dataset.step = getWorkflowStep(step);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Toast ---
function showToast(message, type = 'success', duration = 3000) {
  toast.textContent = message;
  toast.className = 'toast visible ' + type;
  setTimeout(() => { toast.className = 'toast'; }, duration);
}

async function readApiJson(res) {
  const body = await res.text();
  if (!body) return {};

  try {
    return JSON.parse(body);
  } catch {
    const preview = body.replace(/\s+/g, ' ').trim().slice(0, 120);
    const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

    // Hosts answer a function that ran past its time limit with their own non-JSON page
    // (Vercel: 504 FUNCTION_INVOCATION_TIMEOUT), not with our JSON error.
    if (res.status === 504 || /timeout|timed out/i.test(preview)) {
      throw new Error('IdeaBird took too long to generate and the request timed out. Try again, or use a shorter excerpt.');
    }

    if (res.status === 404 || preview.toLowerCase().includes('page could not be found')) {
      throw new Error('IdeaBird API was not found. Run the full app with npm run dev so the backend starts too.');
    }

    if (preview.toLowerCase().includes('connect') || preview.toLowerCase().includes('econnrefused')) {
      throw new Error('IdeaBird backend is not running. Start it with npm run dev:server or use npm run dev.');
    }

    throw new Error(
      isLocalHost
        ? 'IdeaBird received an invalid API response. Make sure the backend is running on http://localhost:3001.'
        : `IdeaBird received an invalid API response (HTTP ${res.status}). Check the Vercel function logs.`
    );
  }
}

async function postGenerateRequest(text) {
  const urls = ['/api/generate'];
  const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  if (isLocalHost && window.location.port !== '3001') {
    urls.push('http://localhost:3001/api/generate');
  }

  const failures = [];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      const data = await readApiJson(res);
      return { res, data };
    } catch (err) {
      failures.push(err);
    }
  }

  const networkFailure = failures.find((err) =>
    err instanceof TypeError ||
    /failed to fetch|networkerror|load failed/i.test(err.message || '')
  );

  if (networkFailure) {
    throw new Error(
      isLocalHost
        ? 'IdeaBird backend is not running. Start the full app with npm run dev, then try Generate again.'
        : 'IdeaBird API is not reachable. Check the Vercel deployment and environment variables.'
    );
  }

  throw failures[failures.length - 1] || new Error('Failed to generate content.');
}

// --- File Validation ---
function validateFile(file) {
  if (!file) return false;
  const validTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif'];
  if (!validTypes.includes(file.type)) {
    showToast('Upload an image file: PNG, JPG, WEBP, BMP, or GIF.', 'error');
    return false;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('That file is larger than 10MB.', 'error');
    return false;
  }
  return true;
}

// --- Handle File ---
async function handleFile(file) {
  if (!validateFile(file)) return;
  currentFile = file;

  // Show preview
  const url = URL.createObjectURL(file);
  previewImage.src = url;

  // Go to extract step
  goToStep(stepExtract);
  extractedText.value = '';
  btnGenerate.disabled = true;
  charCount.textContent = '0 chars';

  // Start OCR
  ocrProgress.classList.add('active');
  ocrProgressBar.style.setProperty('--progress', '0%');
  ocrProgressText.textContent = 'Initializing OCR engine...';

  try {
    const result = await Tesseract.recognize(file, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          ocrProgressBar.style.setProperty('--progress', pct + '%');
          ocrProgressText.textContent = `Recognizing text... ${pct}%`;
        } else if (m.status === 'loading language traineddata') {
          const pct = Math.round(m.progress * 100);
          ocrProgressBar.style.setProperty('--progress', pct + '%');
          ocrProgressText.textContent = `Loading language data... ${pct}%`;
        }
      },
    });

    const text = result.data.text.trim();
    if (!text) {
      showToast('IdeaBird could not find text in this screenshot.', 'error');
      ocrProgress.classList.remove('active');
      return;
    }

    extractedText.value = text;
    charCount.textContent = text.length + ' chars';
    btnGenerate.disabled = false;
    ocrProgress.classList.remove('active');
  } catch (err) {
    console.error('OCR error:', err);
    showToast('OCR failed. Try a cleaner image.', 'error');
    ocrProgress.classList.remove('active');
  }
}

// --- Upload Zone Events ---
uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

['dragenter', 'dragover'].forEach(evt => {
  uploadZone.addEventListener(evt, (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
});

['dragleave', 'drop'].forEach(evt => {
  uploadZone.addEventListener(evt, (e) => { e.preventDefault(); uploadZone.classList.remove('drag-over'); });
});

uploadZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// Paste support
document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) handleFile(file);
      break;
    }
  }
});

// --- Char Count Update ---
extractedText.addEventListener('input', () => {
  charCount.textContent = extractedText.value.length + ' chars';
  btnGenerate.disabled = extractedText.value.trim().length === 0;
});

// --- Generate Tweets ---
async function generateTweets() {
  const text = extractedText.value.trim();
  if (!text || isGenerating) return;

  isGenerating = true;
  btnGenerate.disabled = true;
  btnRegenerate.disabled = true;
  generatingOverlay.classList.add('active');

  try {
    const { res, data } = await postGenerateRequest(text);

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

    renderTweets(data.tweets);
    goToStep(stepResults);
  } catch (err) {
    console.error('Generate error:', err);
    showToast(err.message || 'Failed to generate content. Please try again.', 'error', 5000);
  } finally {
    isGenerating = false;
    btnGenerate.disabled = extractedText.value.trim().length === 0;
    btnRegenerate.disabled = false;
    generatingOverlay.classList.remove('active');
  }
}

// --- Render Tweet Cards ---
function renderTweets(tweets) {
  tweetsGrid.innerHTML = '';

  tweets.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'tweet-card';
    card.style.animationDelay = (i * 0.08) + 's';
    card.style.animation = 'fadeSlideIn 0.4s ease forwards';
    card.style.opacity = '0';

    const len = t.tweet.length;
    const maxLength = getContentMaxLength(t.style);
    const overClass = len > maxLength ? ' over' : '';
    const countLabel = maxLength === 280 ? `${len}/280` : `${len} chars`;

    card.innerHTML = `
      <div class="tweet-card-top">
        <span class="tweet-style-badge">${escapeHtml(t.style)}</span>
        <span class="tweet-char-count${overClass}">${countLabel}</span>
      </div>
      <div class="tweet-text">${escapeHtml(t.tweet)}</div>
      <div class="tweet-card-bottom">
        <button class="copy-btn" data-index="${i}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          Copy
        </button>
      </div>
    `;

    // Copy on card click
    card.addEventListener('click', () => copyTweet(t.tweet, card));

    tweetsGrid.appendChild(card);
  });
}

function getContentMaxLength(style) {
  if (style === 'Thread') return 1800;
  if (style === 'LinkedIn Version') return 1400;
  return 280;
}

// --- Copy ---
async function copyTweet(text, card) {
  try {
    await navigator.clipboard.writeText(text);
    // Reset all cards
    document.querySelectorAll('.tweet-card.copied').forEach(c => {
      c.classList.remove('copied');
      c.querySelector('.copy-btn').innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        Copy`;
    });
    // Mark this card
    card.classList.add('copied');
    card.querySelector('.copy-btn').innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      Copied!`;
    showToast('Tweet copied to clipboard.', 'success');
  } catch {
    showToast('Failed to copy. Please select and copy manually.', 'error');
  }
}

// --- HTML Escape ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Button Handlers ---
btnGenerate.addEventListener('click', generateTweets);
btnBackUpload.addEventListener('click', () => goToStep(stepUpload));

btnStartOver.addEventListener('click', () => {
  currentFile = null;
  fileInput.value = '';
  extractedText.value = '';
  previewImage.src = '';
  tweetsGrid.innerHTML = '';
  charCount.textContent = '0 chars';
  btnGenerate.disabled = true;
  goToStep(stepUpload);
});

btnRegenerate.addEventListener('click', () => {
  goToStep(stepExtract);
  // Small delay then auto-trigger
  setTimeout(() => generateTweets(), 100);
});
