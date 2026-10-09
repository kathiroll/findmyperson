import type {
  CapturePlatform,
  CaptureStatus,
  PermissionStep,
  SettingsTarget,
} from '@findmyperson/native-location-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useDataStore } from '../store/DataStoreContext';
import { useCapture } from './CaptureContext';
import { permissionStage, remedies, type PermissionStage, type Remedy } from './stages';

export type PermissionFlow = {
  /** Null until the first status read resolves. */
  status: CaptureStatus | null;
  stage: PermissionStage | null;
  remedies: Remedy[];
  /** The last settings page that could not be opened, so the screen can say so. */
  settingsUnavailable: SettingsTarget | null;
  /** True once a background request came back without granting "all the time". */
  upgradeNotGranted: boolean;
  /**
   * iOS only: the one-time "Change to Always Allow" request has been used, so asking again does
   * nothing and the person has to use Settings. Always false on Android.
   */
  upgradePromptUsed: boolean;
  busy: boolean;
  request: (step: PermissionStep) => Promise<void>;
  openSettings: (target: SettingsTarget) => Promise<void>;
  declineUpgrade: () => void;
  reconsiderUpgrade: () => void;
};

/**
 * State of the permission flow. All permission work goes through the capture module's
 * `requestPermission`, `openSystemSettings` and `getStatus`; the status is re-read when the app
 * returns to the foreground (the user may have changed it in system settings) and when the module
 * reports a change.
 */
export function usePermissionFlow(platform: CapturePlatform): PermissionFlow {
  const capture = useCapture();
  const dataStore = useDataStore();
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [declined, setDeclined] = useState(false);
  const [settingsUnavailable, setSettingsUnavailable] = useState<SettingsTarget | null>(null);
  const [upgradeNotGranted, setUpgradeNotGranted] = useState(false);
  // Null until the stored flag is read (iOS), so the dead Allow Always button never flashes.
  const [promptUsed, setPromptUsed] = useState<boolean | null>(platform === 'ios' ? null : false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    if (platform !== 'ios') return;
    // A store that cannot be read (phone not yet unlocked) counts as "not used": the button
    // shows, and pressing it records the flag again.
    dataStore.getAlwaysPromptUsed().then(
      (used) => mounted.current && setPromptUsed((was) => was || used),
      () => mounted.current && setPromptUsed((was) => was ?? false),
    );
  }, [platform, dataStore]);

  const refresh = useCallback(async () => {
    const next = await capture.getStatus();
    if (mounted.current) setStatus(next);
    return next;
  }, [capture]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const changed = capture.onStatusChanged((next) => {
      if (mounted.current) setStatus(next);
    });
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      mounted.current = false;
      changed.remove();
      appState.remove();
    };
  }, [capture, refresh]);

  const request = useCallback(
    async (step: PermissionStep) => {
      setBusy(true);
      try {
        if (step === 'background' && platform === 'ios') {
          // The one call iOS honours is spent the moment it is made, whatever the answer.
          setPromptUsed(true);
          void dataStore.markAlwaysPromptUsed().catch(() => undefined);
        }
        const result = await capture.requestPermission(step);
        if (step === 'background') setUpgradeNotGranted(result !== 'always');
        await refresh();
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [capture, dataStore, platform, refresh],
  );

  const openSettings = useCallback(
    async (target: SettingsTarget) => {
      const opened = await capture.openSystemSettings(target);
      if (mounted.current) setSettingsUnavailable(opened ? null : target);
    },
    [capture],
  );

  return {
    status,
    stage: status && promptUsed !== null ? permissionStage(status, platform, declined) : null,
    remedies: status ? remedies(status) : [],
    settingsUnavailable,
    upgradeNotGranted,
    upgradePromptUsed: promptUsed === true,
    busy,
    request,
    openSettings,
    declineUpgrade: () => setDeclined(true),
    reconsiderUpgrade: () => setDeclined(false),
  };
}
