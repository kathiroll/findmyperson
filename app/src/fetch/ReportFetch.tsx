import { useCallback, useMemo } from 'react';
import { useCapture } from '../permissions';
import { useAppWake, useDataStore } from '../store';
import { createFetchTrigger, type FetchTrigger } from './trigger';

/**
 * Fetches reports at the moments the app wakes (useAppWake): at start, on every foreground and
 * on every capture wake that reaches JavaScript. Renders nothing; it sits once at the root of
 * the app, beside StoreMaintenance and inside the same providers.
 *
 * What a wake does, how often, and what happens to its result is the trigger's (./trigger.ts).
 * Until a build is given a CDN origin and trusted keys (./reportCdn.ts) every wake ends there
 * as `unconfigured`.
 *
 * A fetch that stores reports owing a match is followed at once by a maintenance run of the
 * store, whose last step is the match runner (the trigger asks for it): the same wake's own
 * run came before the fetch and could not have seen them.
 */
export function ReportFetch({
  trigger,
}: {
  /** Production leaves it out and gets the real one, on this build's report source. */
  trigger?: FetchTrigger;
}) {
  const dataStore = useDataStore();
  const capture = useCapture();
  const active = useMemo(
    () => trigger ?? createFetchTrigger({ dataStore, capture }),
    [trigger, dataStore, capture],
  );
  // run never rejects, and calls made while a run is in progress join it.
  useAppWake(useCallback(() => void active.run(), [active]));
  return null;
}
