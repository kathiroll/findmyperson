import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useCapture } from '../permissions';

/** Which moment woke the app's background work. */
export type AppWake = 'start' | 'foreground' | 'capture';

/**
 * The moments at which the app does its background work, in one place so that everything that
 * has to happen "when the app wakes" happens at the same ones: the store's maintenance
 * (StoreMaintenance) and the report fetch (ReportFetch).
 *
 *   at start             when the component mounts, once
 *   on every foreground  each time the app comes back to the screen
 *   on a capture wake    each stored sample the capture module reports: JavaScript is running
 *                        and the app may well be in the background
 *
 * A wake that stores a fix with no JavaScript running is not seen here.
 *
 * `onWake` is told which of the three it is. It is called synchronously and its result is
 * ignored, so it must not throw and must handle its own failures. Pass a stable function
 * (useCallback): a new one is a new mount.
 */
export function useAppWake(onWake: (wake: AppWake) => void): void {
  const capture = useCapture();

  useEffect(() => {
    onWake('start');
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') onWake('foreground');
    });
    const sampleWritten = capture.onSampleWritten(() => {
      onWake('capture');
    });
    return () => {
      appState.remove();
      sampleWritten.remove();
    };
  }, [capture, onWake]);
}
