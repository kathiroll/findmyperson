import type { CaptureStatus } from '@findmyperson/native-location-capture';
import { CaptureHealthCard } from '../design-system';
import { FLAG_INFO, sortFlags } from './flags';
import { ago, nowSec } from './healthLog';
import { useCaptureHealth } from './useCaptureHealth';
import { useFix } from './useFix';

export type CaptureHealthStatusProps = {
  /** Opens the in-app permission flow (for the "allow all the time" fix). */
  onOpenPermissionFlow: () => void;
  /** Opens the diagnostics screen; used when the module reports a problem with no direct fix. */
  onOpenDiagnostics: () => void;
  /** Injectable clock for tests: Unix seconds. */
  now?: () => number;
};

function healthyDetail(status: CaptureStatus, nowSec: number): string {
  const last =
    status.lastSampleTsUtc === null
      ? 'Nothing saved yet.'
      : `Last saved ${ago(status.lastSampleTsUtc, nowSec)}.`;
  return `On this phone only. ${last}`;
}

/**
 * Home's status row: the design system's capture-health card showing what `getStatus` reports,
 * green only when the module raises no health flag, otherwise naming the first flag and its fix.
 */
export function CaptureHealthStatus({
  onOpenPermissionFlow,
  onOpenDiagnostics,
  now = nowSec,
}: CaptureHealthStatusProps) {
  const { status, unavailable } = useCaptureHealth();
  const runFix = useFix(onOpenPermissionFlow);

  if (status === null) {
    if (!unavailable) return null;
    return (
      <CaptureHealthCard
        state="broken"
        testID="capture-health-status"
        title="Capture status unavailable"
        body="The app could not ask the location module how capture is doing, so it cannot tell you that it is working."
        action={{ label: 'See details', onPress: onOpenDiagnostics }}
      />
    );
  }

  const [flag] = sortFlags(status.health);
  if (flag === undefined) {
    return (
      <CaptureHealthCard
        state="healthy"
        testID="capture-health-status"
        title={status.mode === 'stopped' ? 'Tracking is paused' : 'Working normally'}
        detail={healthyDetail(status, now())}
        pulse={status.running}
      />
    );
  }

  const info = FLAG_INFO[flag];
  const more = status.health.length - 1;
  const fix = info.fix;
  return (
    <CaptureHealthCard
      state="broken"
      testID="capture-health-status"
      title={info.title}
      body={
        more > 0
          ? `${info.body} ${more} more ${more === 1 ? 'problem' : 'problems'} in details.`
          : info.body
      }
      action={
        fix.kind === 'none'
          ? { label: 'See details', onPress: onOpenDiagnostics }
          : { label: fix.label, onPress: () => runFix(fix) }
      }
      {...(info.path ? { path: info.path } : {})}
    />
  );
}
