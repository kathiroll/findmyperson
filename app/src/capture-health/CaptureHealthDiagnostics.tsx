import type { DiagnosticEntry } from '@findmyperson/native-location-capture';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  CaptureHealthCard,
  ScreenHeader,
  Text,
  colors,
  sizes,
  spacing,
} from '../design-system';
import { useCapture } from '../permissions';
import { FLAG_INFO, sortFlags } from './flags';
import { formatHealthLog, nowSec } from './healthLog';
import { useCaptureHealth } from './useCaptureHealth';
import { useFix } from './useFix';

const LOG_WINDOW_SEC = 7 * 86400;

export type CaptureHealthDiagnosticsProps = {
  onBack: () => void;
  onOpenPermissionFlow: () => void;
  now?: () => number;
};

/**
 * Diagnostics behind Settings: the module's current `HealthFlag` set, each with its own fix, and
 * the local capture-health log from `getDiagnostics`. Nothing here leaves the device.
 */
export function CaptureHealthDiagnostics({
  onBack,
  onOpenPermissionFlow,
  now = nowSec,
}: CaptureHealthDiagnosticsProps) {
  const insets = useSafeAreaInsets();
  const capture = useCapture();
  const { status, unavailable, refresh } = useCaptureHealth();
  const runFix = useFix(onOpenPermissionFlow);
  const [entries, setEntries] = useState<DiagnosticEntry[] | null>(null);
  const [logFailed, setLogFailed] = useState(false);

  const loadLog = useCallback(async () => {
    try {
      setEntries(await capture.getDiagnostics(now() - LOG_WINDOW_SEC));
      setLogFailed(false);
    } catch {
      setLogFailed(true);
    }
  }, [capture, now]);

  // Reload the log whenever the status changes: the module logs the transitions.
  useEffect(() => {
    void loadLog();
  }, [loadLog, status]);

  const flags = status ? sortFlags(status.health) : [];

  return (
    <View
      testID="screen-CaptureHealth"
      style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}
    >
      <ScreenHeader variant="back" title="Capture health" onBackPress={onBack} />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: sizes.gutter,
          paddingTop: spacing[24],
          paddingBottom: spacing[24] + insets.bottom,
          gap: spacing[20],
        }}
      >
        <Text variant="title" accessibilityRole="header">
          Capture health
        </Text>

        {status === null ? (
          <Text variant="body" color="muted" testID="health-loading">
            {unavailable
              ? 'The location module did not answer, so the state of capture is unknown.'
              : 'Checking…'}
          </Text>
        ) : flags.length === 0 ? (
          <CaptureHealthCard
            state="healthy"
            testID="health-ok"
            title={status.mode === 'stopped' ? 'Tracking is paused' : 'Working normally'}
            detail="The location module reports no problems."
            pulse={status.running}
          />
        ) : (
          flags.map((flag) => {
            const info = FLAG_INFO[flag];
            return (
              <CaptureHealthCard
                key={flag}
                state="broken"
                testID={`health-flag-${flag}`}
                title={info.title}
                body={info.body}
                action={{
                  label: info.fix.kind === 'none' ? 'Check again' : info.fix.label,
                  onPress: () => (info.fix.kind === 'none' ? void refresh() : runFix(info.fix)),
                }}
                {...(info.path ? { path: info.path } : {})}
              />
            );
          })
        )}

        <Card variant="surface">
          <Text variant="heading" accessibilityRole="header">
            Troubleshooting log
          </Text>
          <Text variant="caption" color="muted">
            Kept on this phone only, for your own troubleshooting. It holds no locations and is
            never sent anywhere.
          </Text>
          {status !== null && (entries !== null || logFailed) ? (
            <Text variant="caption" selectable testID="health-log">
              {logFailed
                ? 'The log could not be read.'
                : formatHealthLog(status, entries ?? [], now())}
            </Text>
          ) : null}
          <Button label="Refresh" variant="tint" onPress={() => void refresh().then(loadLog)} />
        </Card>
      </ScrollView>
    </View>
  );
}
