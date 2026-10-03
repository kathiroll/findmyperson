import type { CaptureConfig, HealthFlag } from './specs/NativeLocationCapture';

/**
 * The parts of the capture contract that are values, not types: names the native modules
 * register under, the codes a rejected promise carries, the diagnostic events both platforms
 * share. The interface itself is src/specs/NativeLocationCapture.ts.
 */

/** The name both native modules register under, and the name the spec asks the registry for. */
export const NATIVE_MODULE_NAME = 'NativeLocationCapture';

export type CapturePlatform = 'android' | 'ios';

/**
 * Every health flag and the platforms that can raise it. The key order is the order flags
 * appear in `CaptureStatus.health`.
 */
export const HEALTH_FLAG_PLATFORMS = {
  background_permission_missing: ['android', 'ios'],
  precise_location_off: ['android', 'ios'],
  location_services_off: ['android', 'ios'],
  service_not_running: ['android', 'ios'],
  store_unusable: ['android', 'ios'],
  background_refresh_off: ['ios'],
  low_power_mode: ['ios'],
  battery_optimisation_active: ['android'],
  hibernation_not_exempt: ['android'],
  oem_restriction_suspected: ['android'],
} as const satisfies Record<HealthFlag, readonly CapturePlatform[]>;

export const HEALTH_FLAGS = Object.keys(HEALTH_FLAG_PLATFORMS) as HealthFlag[];

/**
 * The `code` of the error a rejected promise carries, on both platforms.
 *
 *   invalid_argument   a value in the call is out of range (for example minIntervalSec <= 0)
 *   permission_denied  `start` without at least foreground location permission
 *   store_unusable     the store failed the check `initStore` makes
 *   start_failed       the OS refused to start the capture mechanism
 *   not_available      the method does not exist in this build (`debugInjectSample` in release)
 */
export const CAPTURE_ERROR_CODES = [
  'invalid_argument',
  'permission_denied',
  'store_unusable',
  'start_failed',
  'not_available',
] as const;
export type CaptureErrorCode = (typeof CAPTURE_ERROR_CODES)[number];

/** The capture error code of a rejection, or null if it is some other error. */
export function captureErrorCode(error: unknown): CaptureErrorCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return (CAPTURE_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as CaptureErrorCode)
    : null;
}

/**
 * `DiagnosticEntry.event` names both platforms write for the same thing, with what `detail`
 * holds. The first three are the M0 trial apps' own log lines. A platform may log more.
 */
export const DIAGNOSTIC_EVENTS = {
  /** The selection changed. detail: the new CaptureMode, `stopped` included. */
  modeChanged: 'mode_changed',
  /** A mechanism came alive. detail: its CaptureMode. */
  captureStarted: 'capture_started',
  /** A mechanism was stopped on purpose. detail: its CaptureMode. */
  captureStopped: 'capture_stopped',
  /** The OS refused to start a mechanism. detail: the reason. */
  startFailed: 'start_failed',
  /** The store check failed. detail: the failed step. */
  storeUnusable: 'store_unusable',
} as const;

/**
 * Production capture settings: the cadence of plan 5.2 and 5.5, and the default Android mode
 * `wm` (no foreground service, no notification; captain decision, plan addendum 2026-10-02).
 * The app adds the notification text and passes the result to `start`.
 */
export const CAPTURE_DEFAULTS = {
  minIntervalSec: 900,
  minDistanceM: 100,
  accuracy: 'balanced',
  useForegroundService: false,
} as const satisfies Omit<CaptureConfig, 'notificationTitle' | 'notificationBody'>;
