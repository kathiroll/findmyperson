import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useCapture } from '../permissions';
import { useReportApi } from '../report/services';
import { useDataStore } from './DataStoreContext';

/**
 * Runs the store's maintenance at the moments the app has to do it. Renders nothing; it sits
 * once at the root of the app, inside the capture and data-store providers.
 *
 *   at start             opens the store and purges whatever went past retention while the
 *                        app was closed, in one pass however long that was
 *   on every foreground  the same, each time the app comes back to the screen
 *   (both of those also send any report still queued from being offline)
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
  const reportApi = useReportApi();

  useEffect(() => {
    // runMaintenance never rejects, and calls made while a run is in progress join it.
    // A report queued offline is sent as soon as the app is open again. It never rejects the
    // app: a row that cannot be sent stays queued for the next trigger.
    const sendQueuedReports = () => void dataStore.runReportQueue(reportApi).catch(() => undefined);
    void dataStore.runMaintenance();
    sendQueuedReports();
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void dataStore.runMaintenance();
        sendQueuedReports();
      }
    });
    const sampleWritten = capture.onSampleWritten(() => {
      void dataStore.runMaintenance();
    });
    return () => {
      appState.remove();
      sampleWritten.remove();
    };
  }, [dataStore, capture, reportApi]);

  return null;
}
