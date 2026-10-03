import type { CaptureStatus, DiagnosticEntry } from '@findmyperson/native-location-capture';
import { FLAG_INFO, sortFlags } from './flags';

/** Default clock for the screens: Unix seconds. A module-level function so it is referentially stable. */
export const nowSec = (): number => Math.floor(Date.now() / 1000);

const iso = (tsUtc: number) => new Date(tsUtc * 1000).toISOString();

/** "6 min ago", "2 h ago", "3 d ago". */
export function ago(tsUtc: number, nowSec: number): string {
  const s = Math.max(0, nowSec - tsUtc);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * The troubleshooting log as plain text, for showing on screen. It is built only from the
 * module's status and its own local diagnostics (no coordinates, see DiagnosticEntry) and is
 * never sent anywhere by the app.
 */
export function formatHealthLog(
  status: CaptureStatus,
  entries: readonly DiagnosticEntry[],
  nowSec: number,
): string {
  const lines = [
    `Checked: ${iso(nowSec)}`,
    `Mode: ${status.mode} · tier: ${status.tier} · running: ${status.running ? 'yes' : 'no'}`,
    `Location permission: ${status.permission}`,
    `Problems: ${status.health.length ? sortFlags(status.health).join(', ') : 'none'}`,
    `Last saved: ${status.lastSampleTsUtc === null ? 'never' : iso(status.lastSampleTsUtc)}`,
    `Saved in last 24 h: ${status.samplesLast24h} of about ${status.expectedLast24h} expected`,
    '',
    entries.length ? 'Events:' : 'No events recorded yet.',
    ...entries.map((e) => `${iso(e.tsUtc)}  ${e.event}${e.detail ? `  ${e.detail}` : ''}`),
  ];
  return lines.join('\n');
}

/** Plain-language one-liner for each flag, for the list in the diagnostics screen. */
export const describeFlags = (status: Pick<CaptureStatus, 'health'>): string[] =>
  sortFlags(status.health).map((f) => FLAG_INFO[f].title);
