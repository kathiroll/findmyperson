import type { CapturePlatform, LocationCapture } from '@findmyperson/native-location-capture';
import type { RetentionOptions } from '@findmyperson/shared';

/**
 * THE WEEKLY VACUUM IS SWITCHED OFF ON ANDROID. This flag is the switch.
 *
 * It was switched off because the store file used to be read and written by two copies of
 * SQLite in one Android process, op-sqlite's for TypeScript and a second one for Kotlin, which
 * did not see each other's file locks. A fix written while VACUUM rewrote the whole file was
 * exposed to that for far longer than a fix that met one small write.
 *
 * The cause is gone from the build: the Kotlin side now uses the SQLite inside op-sqlite's
 * library ("One SQLite library in the Android process" in packages/encrypted-store/README.md),
 * and the build fails if a second copy comes back. What has not happened is a run on a phone,
 * so the flag stays off until the checks that section lists under "Before the Android vacuum
 * is switched on" have been made on a device (fmp-android-sqlite-contention). Everything else
 * about retention runs on Android as on iOS: the purge, natively and in TypeScript, and the
 * charging-and-idle answer the vacuum would wait for.
 *
 * Turning it on is that verification and nothing else: set this to true. While it is false
 * every maintenance run on Android reports the vacuum as `disabled` (VacuumOutcome in
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
