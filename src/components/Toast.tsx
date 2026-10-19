import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastType } from '../types';

interface ToastState {
  message: string;
  type: ToastType;
  visible: boolean;
}

export function useToast() {
  const [toast, setToast] = useState<ToastState>({ message: '', type: 'success', visible: false });
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const showToast = useCallback((message: string, type: ToastType = 'success', duration = 3000) => {
    clearTimeout(timerRef.current);
    setToast({ message, type, visible: true });
    timerRef.current = setTimeout(() => setToast((current) => ({ ...current, visible: false })), duration);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { toast, showToast };
}

export function Toast({ toast }: { toast: ToastState }) {
  return (
    <div className={toast.visible ? `toast visible ${toast.type}` : 'toast'} id="toast">
      {toast.message}
    </div>
  );
}
