import { useEffect, useRef, useState } from 'react';

interface GoogleIdentity {
  accounts: {
    id: {
      initialize(options: { client_id: string; callback: (response: { credential: string }) => void; ux_mode?: 'popup' }): void;
      renderButton(element: HTMLElement, options: Record<string, unknown>): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

let scriptPromise: Promise<GoogleIdentity> | null = null;

function loadGoogleIdentity(): Promise<GoogleIdentity> {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => (window.google ? resolve(window.google) : reject(new Error('Google sign-in failed to load.')));
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Google sign-in failed to load.'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface GoogleButtonProps {
  clientId: string;
  onCredential: (credential: string) => void;
  onError: (message: string) => void;
}

/** Google Identity Services button. Google returns a signed ID token the server verifies. */
export function GoogleButton({ clientId, onCredential, onError }: GoogleButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  callbackRef.current = onCredential;
  const [failed, setFailed] = useState(false);
  // Google first paints an unstyled fallback (a huge logo) before its iframe loads.
  // Keep the button hidden until the iframe is in, so the form doesn't jump.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const check = () => {
      if (node.querySelector('iframe')) setReady(true);
    };
    const observer = new MutationObserver(check);
    observer.observe(node, { childList: true, subtree: true });
    // Never leave it hidden for good if Google changes its markup.
    const fallback = window.setTimeout(() => setReady(true), 4000);
    return () => {
      observer.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadGoogleIdentity()
      .then((google) => {
        if (cancelled || !containerRef.current) return;
        google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          callback: ({ credential }) => callbackRef.current(credential),
        });
        google.accounts.id.renderButton(containerRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'continue_with',
          logo_alignment: 'center',
          width: containerRef.current.offsetWidth || 320,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setFailed(true);
        onError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, onError]);

  if (failed) return null;
  return <div className={`google-button${ready ? ' ready' : ''}`} ref={containerRef} />;
}
