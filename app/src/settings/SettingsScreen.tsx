import { CAPTURE_DEFAULTS, type CaptureStatus } from '@findmyperson/native-location-capture';
import { RETENTION_DAYS } from '@findmyperson/shared';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Linking, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  InfoBanner,
  ScreenHeader,
  Text,
  colors,
  sizes,
  spacing,
} from '../design-system';
import { useCapture } from '../permissions';
import { useDataStore } from '../store';
import { ABUSE_CONTACT_URL, POLICIES_URL } from './links';

export type SettingsScreenProps = {
  /**
   * THE SEAM for the capture-health diagnostics task: Settings only calls this. The route it
   * opens is `CaptureHealth` (routes.ts); the diagnostics screen replaces `CaptureHealthScreen`
   * in navigation/screens.tsx and needs no change here.
   */
  onOpenCaptureHealth: () => void;
  /** Opens the permission flow, for when location access is missing. */
  onOpenPermissionFlow: () => void;
};

const NOTIFICATION = {
  notificationTitle: 'findmyperson is saving your location',
  notificationBody: 'Stored on this phone only. Pause it any time in Settings.',
};

const hasPermission = (status: CaptureStatus) =>
  status.permission === 'foreground_only' || status.permission === 'always';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: spacing[12] }}>
      <Text variant="heading" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function SettingsScreen({ onOpenCaptureHealth, onOpenPermissionFlow }: SettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const capture = useCapture();
  const dataStore = useDataStore();
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const next = await capture.getStatus();
    if (mounted.current) setStatus(next);
  }, [capture]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const changed = capture.onStatusChanged((next) => {
      if (mounted.current) setStatus(next);
    });
    return () => {
      mounted.current = false;
      changed.remove();
    };
  }, [capture, refresh]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError(messageOf(e));
    } finally {
      if (mounted.current) setBusy(false);
      await refresh().catch(() => undefined);
    }
  };

  const pause = () =>
    run(async () => {
      await capture.stop();
      setNotice('Tracking is paused. Nothing new is being saved.');
    });

  const resume = () =>
    run(async () => {
      await capture.start({ ...CAPTURE_DEFAULTS, ...NOTIFICATION });
      setNotice('Tracking is on.');
    });

  const deleteAll = () =>
    run(async () => {
      setConfirmingDelete(false);
      // The store package's documented order: stop capture first, because the capture module
      // writes into the new store as soon as it exists; then delete; then the new store is
      // checked to be empty. Tracking stays off until the person turns it on again.
      await capture.stop();
      await dataStore.deleteAll();
      setNotice('All your data was deleted from this phone. Tracking is paused.');
    });

  const open = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      setError('Could not open that link on this phone.');
    }
  };

  const running = status?.running === true;
  const allowed = status !== null && hasPermission(status);

  return (
    <View
      testID="screen-Settings"
      style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}
    >
      <ScreenHeader variant="brand" />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: sizes.gutter,
          paddingTop: spacing[16],
          paddingBottom: spacing[24] + insets.bottom,
          gap: spacing[24],
        }}
      >
        <Text variant="title" accessibilityRole="header">
          Settings
        </Text>

        {error !== null ? (
          <InfoBanner icon="alert" message={error} testID="settings-error" />
        ) : null}
        {notice !== null ? <InfoBanner message={notice} testID="settings-notice" /> : null}

        <Section title="Tracking">
          <Card testID="settings-tracking">
            <Text variant="itemTitle" testID="settings-tracking-state">
              {status === null
                ? 'Checking…'
                : running
                  ? 'Tracking is on'
                  : allowed
                    ? 'Tracking is paused'
                    : 'Tracking is off'}
            </Text>
            <Text variant="bodySmall" color="muted">
              {allowed || status === null
                ? 'Pausing stops saving your location right away. What is already saved stays on this phone until it expires or you delete it.'
                : 'findmyperson needs location access before it can save anything.'}
            </Text>
            {status === null ? null : running ? (
              <Button
                label="Pause tracking"
                variant="tint"
                disabled={busy}
                onPress={() => void pause()}
              />
            ) : allowed ? (
              <Button label="Resume tracking" disabled={busy} onPress={() => void resume()} />
            ) : (
              <Button
                label="Enable location access"
                disabled={busy}
                onPress={onOpenPermissionFlow}
              />
            )}
          </Card>
          <Button
            label="Capture health"
            variant="ghost"
            trailingIcon="arrow"
            testID="settings-capture-health"
            onPress={onOpenCaptureHealth}
          />
        </Section>

        <Section title="What is kept">
          <Card testID="settings-retention">
            <Text variant="bodySmall">
              While tracking is on, findmyperson saves a point about every{' '}
              {CAPTURE_DEFAULTS.minIntervalSec / 60} minutes, or sooner if you have moved{' '}
              {CAPTURE_DEFAULTS.minDistanceM} metres: the time, the place and how accurate it was.
            </Text>
            <Text variant="bodySmall">
              Points are kept for {RETENTION_DAYS} days, then deleted. They are stored encrypted on
              this phone and are left out of cloud and device backups.
            </Text>
            <Text variant="bodySmall">
              You can delete everything now, at any time, with the button below.
            </Text>
          </Card>
        </Section>

        <Section title="Delete my data">
          {confirmingDelete ? (
            <Card variant="attention" testID="settings-delete-confirm">
              <Text variant="itemTitle">Delete everything on this phone?</Text>
              <Text variant="bodySmall" color="muted">
                This stops tracking and permanently erases your saved location history. It cannot be
                undone.
              </Text>
              <Button
                label="Yes, delete all my data"
                variant="destructive"
                disabled={busy}
                onPress={() => void deleteAll()}
              />
              <Button
                label="Cancel"
                variant="ghost"
                disabled={busy}
                onPress={() => setConfirmingDelete(false)}
              />
            </Card>
          ) : (
            <Button
              label="Delete all my data"
              variant="destructive"
              disabled={busy}
              onPress={() => setConfirmingDelete(true)}
            />
          )}
        </Section>

        <Section title="About">
          <Button
            label="Policies"
            variant="ghost"
            trailingIcon="external"
            onPress={() => void open(POLICIES_URL)}
          />
          <Button
            label="Report abuse"
            variant="ghost"
            trailingIcon="external"
            onPress={() => void open(ABUSE_CONTACT_URL)}
          />
        </Section>
      </ScrollView>
    </View>
  );
}
