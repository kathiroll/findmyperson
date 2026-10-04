import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useCapture } from '../permissions';
import { useDataStore } from './DataStoreContext';

/**
 * Runs the store's maintenance at the moments the app has to do it. Renders nothing; it sits
 * once at the root of the app, inside the capture and data-store providers.
 *
 *   at start             opens the store and purges whatever went past retention while the
 *                        app was closed, in one pass however long that was
 *   on every foreground  the same, each time the app comes back to the screen
 *   on a capture wake    each stored sample the capture module reports: JavaScript is running
 *                        and the app may well be in the background, which is the only moment
 *                        a VACUUM that is due can find the phone idle
 *
 * A wake that stores a fix with no JavaScript running is not seen here. The capture modules
 * purge fixes and stays themselves on those (native-writer.json), so retention does not depend
 * on this component ever mounting.
 */
export function StoreMaintenance() {
  const dataStore = useDataStore();
  const capture = useCapture();

  useEffect(() => {
    // runMaintenance never rejects, and calls made while a run is in progress join it.
    void dataStore.runMaintenance();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void dataStore.runMaintenance();
    });
    const sampleWritten = capture.onSampleWritten(() => {
      void dataStore.runMaintenance();
    });
    return () => {
      appState.remove();
      sampleWritten.remove();
    };
  }, [dataStore, capture]);

  return null;
}
