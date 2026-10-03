import type {
  CapturePlatform,
  CaptureStatus,
  PermissionStep,
  SettingsTarget,
} from '@findmyperson/native-location-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
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
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [declined, setDeclined] = useState(false);
  const [settingsUnavailable, setSettingsUnavailable] = useState<SettingsTarget | null>(null);
  const [upgradeNotGranted, setUpgradeNotGranted] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

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
        const result = await capture.requestPermission(step);
        if (step === 'background') setUpgradeNotGranted(result !== 'always');
        await refresh();
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [capture, refresh],
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
    stage: status ? permissionStage(status, platform, declined) : null,
    remedies: status ? remedies(status) : [],
    settingsUnavailable,
    upgradeNotGranted,
    busy,
    request,
    openSettings,
    declineUpgrade: () => setDeclined(true),
    reconsiderUpgrade: () => setDeclined(false),
  };
}
