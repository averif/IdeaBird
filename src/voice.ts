import { useCallback, useEffect, useState } from 'react';
import { apiJson } from './auth/client';
import type { ToastType } from './types';

/** Write Like Me state for the signed-in user (mirrors GET /api/voice). */
export interface VoiceStatus {
  /** False when the server has no X app configured: the feature is hidden. */
  available: boolean;
  connection: { username: string; status: 'active' | 'expired' } | null;
  profile: {
    summary: string;
    traits: Record<string, string[]>;
    avoid: string[];
    measured: string[];
    postCount: number;
    enabled: boolean;
    updatedAt: string;
  } | null;
}

// Where the X authorization ended, from the ?voice= parameter on the way back.
const CONNECT_RESULTS: Record<string, { message: string; type: ToastType }> = {
  denied: { message: "X wasn't connected. You can still use IdeaBird without Write Like Me.", type: 'error' },
  invalid: { message: "X wasn't connected: the request expired or was opened in another browser. Try connecting again.", type: 'error' },
  failed: { message: "X wasn't connected because X didn't respond. You can still use IdeaBird without Write Like Me.", type: 'error' },
};

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/**
 * Loads and changes Write Like Me. Learning (fetching posts + analysis) only
 * happens right after connecting and when the user asks for a refresh.
 */
export function useVoice(showToast: (message: string, type?: ToastType, duration?: number) => void, onConnected: () => void) {
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [learning, setLearning] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => apiJson<VoiceStatus>('/api/voice').then(setVoice).catch(() => {}), []);

  const learn = useCallback(async () => {
    setLearning(true);
    try {
      setVoice(await apiJson<VoiceStatus>('/api/voice/refresh', { method: 'POST' }));
      showToast('Your voice is ready. New posts will sound like you.', 'success', 5000);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Something went wrong.', 'error', 7000);
      await load(); // e.g. the connection may now need reconnecting
    } finally {
      setLearning(false);
    }
  }, [load, showToast]);

  // Back from X: /?voice=connected|denied|invalid|failed. Clear it from the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('voice');
    if (result) {
      params.delete('voice');
      const rest = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
    }
    if (result === 'connected') {
      onConnected();
      load().then(learn);
      return;
    }
    if (result && CONNECT_RESULTS[result]) showToast(CONNECT_RESULTS[result].message, CONNECT_RESULTS[result].type, 7000);
    load();
    // Runs once, on arrival.
  }, []);

  const act = async (action: () => Promise<VoiceStatus | void>) => {
    setBusy(true);
    try {
      const next = await action();
      if (next) setVoice(next);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return {
    voice,
    learning,
    busy,
    learn,
    connect: () =>
      act(async () => {
        const { url } = await apiJson<{ url: string }>('/api/voice/connect', { method: 'POST' });
        window.location.assign(url);
      }),
    setEnabled: (enabled: boolean) => act(() => apiJson<VoiceStatus>('/api/voice', { method: 'PATCH', ...json({ enabled }) })),
    disconnect: () =>
      act(async () => {
        const next = await apiJson<VoiceStatus>('/api/voice', { method: 'DELETE' });
        showToast('X disconnected. Your voice profile was deleted.', 'success');
        return next;
      }),
  };
}

export type VoiceControls = ReturnType<typeof useVoice>;
