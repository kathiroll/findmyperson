import type { CaptureStatus } from '@findmyperson/native-location-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useCapture } from '../permissions';

/** The status is re-read this often while a screen shows it, besides on every change event. */
export const HEALTH_POLL_MS = 60_000;

export type CaptureHealth = {
  /** Null until the first read resolves. */
  status: CaptureStatus | null;
  /** True if the last read failed and no status has ever been read. */
  unavailable: boolean;
  refresh: () => Promise<CaptureStatus | null>;
};

/**
 * Live capture status from the module's `getStatus`: read on mount, on a timer, when the app
 * returns to the foreground (the user may have fixed something in system settings) and when the
 * module reports a change.
 */
export function useCaptureHealth(pollMs: number = HEALTH_POLL_MS): CaptureHealth {
  const capture = useCapture();
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await capture.getStatus();
      if (mounted.current) {
        setStatus(next);
        setUnavailable(false);
      }
      return next;
    } catch {
      if (mounted.current) setUnavailable(true);
      return null;
    }
  }, [capture]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    const changed = capture.onStatusChanged((next) => {
      if (mounted.current) {
        setStatus(next);
        setUnavailable(false);
      }
    });
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      mounted.current = false;
      clearInterval(timer);
      changed.remove();
      appState.remove();
    };
  }, [capture, pollMs, refresh]);

  return { status, unavailable, refresh };
}
