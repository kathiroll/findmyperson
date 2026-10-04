import type { CapturePlatform, LocationCapture } from '@findmyperson/native-location-capture';
import type { RetentionOptions } from '@findmyperson/shared';

/**
 * THE WEEKLY VACUUM IS SWITCHED OFF ON ANDROID. This flag is the switch.
 *
 * On Android the store file is read and written by two copies of SQLite in one process:
 * op-sqlite's, which TypeScript uses, and the Kotlin capture module's. They do not see each
 * other's file locks ("Open decision: two SQLite libraries in one Android process" in
 * packages/encrypted-store/README.md). A fix written while VACUUM rewrites the whole file is
 * exposed to that for far longer than a fix that meets one small write, so the vacuum stays
 * off there until the decision is made (held for the captain as
 * fmp-android-sqlite-contention). Everything else about retention runs on Android as on iOS:
 * the purge, natively and in TypeScript, and the charging-and-idle answer the vacuum would
 * wait for.
 *
 * Turning it on is that decision and nothing else: set this to true. While it is false every
 * maintenance run on Android reports the vacuum as `disabled` (VacuumOutcome in
 * @findmyperson/shared), so the file keeps the pages the purge frees and reuses them, and does
 * not shrink.
 */
export const ANDROID_VACUUM_ENABLED = false;

/**
 * What the app passes to createRetentionMaintenance: the capture module answers whether the
 * phone is charging and idle, and the platform decides whether the vacuum may run at all.
 */
export function retentionOptions(
  capture: Pick<LocationCapture, 'getDeviceConditions'>,
  platform: CapturePlatform,
): RetentionOptions {
  return {
    deviceConditions: () => capture.getDeviceConditions(),
    vacuum: platform === 'android' && !ANDROID_VACUUM_ENABLED ? 'disabled' : 'enabled',
  };
}
