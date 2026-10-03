import type { HealthFlag, SettingsTarget } from '@findmyperson/native-location-capture';

/** What the fix button does: open a system settings page, or go to the in-app permission flow. */
export type Fix =
  | { kind: 'settings'; target: SettingsTarget; label: string }
  | { kind: 'permission'; label: string }
  | { kind: 'none' };

export type FlagInfo = {
  /** Short plain-language name, used as the broken card's title and in the diagnostics list. */
  title: string;
  /** What is wrong and what it costs. */
  body: string;
  fix: Fix;
  /** Where the setting lives, shown under the button. */
  path?: string;
};

/**
 * Every HealthFlag the two capture modules can report, in the order the most blocking problem
 * comes first. Keyed by the module's own type, so a flag added to the spec fails to compile here
 * until it has copy and a fix.
 */
export const FLAG_INFO: Record<HealthFlag, FlagInfo> = {
  store_unusable: {
    title: 'Saved locations cannot be read',
    body: 'The private store on this phone could not be opened, so nothing is being saved. Restart the app; if this stays, delete your data in Settings and start again.',
    fix: { kind: 'none' },
  },
  location_services_off: {
    title: 'Location is switched off on this phone',
    body: 'Nothing can be captured until location is turned back on in system settings.',
    fix: { kind: 'settings', target: 'app', label: 'Open settings' },
    path: 'Settings › Location',
  },
  background_permission_missing: {
    title: 'Background location is off',
    body: 'Capture only works well when location is allowed "all the time". Without it the phone delivers fixes only now and then while the app is closed.',
    fix: { kind: 'permission', label: 'Allow location all the time' },
    path: 'Settings › Apps › findmyperson › Permissions › Location',
  },
  precise_location_off: {
    title: 'Only approximate location is allowed',
    body: 'Matching works best with precise location. Switch "Precise" on for this app.',
    fix: { kind: 'settings', target: 'app', label: 'Open settings' },
    path: 'Settings › findmyperson › Location › Precise',
  },
  service_not_running: {
    title: 'Capture stopped running',
    body: 'Tracking is switched on but the part of the app that records locations is not alive. Open the app again to restart it; if it keeps stopping, remove battery limits for this app.',
    fix: { kind: 'settings', target: 'battery', label: 'Open battery settings' },
  },
  battery_optimisation_active: {
    title: 'Battery saver may stop capture',
    body: 'Let the app run in the background without battery restrictions, and allow autostart if your phone has that option.',
    fix: { kind: 'settings', target: 'battery', label: 'Exempt from battery optimisation' },
    path: 'Settings › Apps › findmyperson › Battery › Unrestricted',
  },
  hibernation_not_exempt: {
    title: 'App activity may be paused when unused',
    body: 'Turn off "Pause app activity if unused" so capture keeps running when you have not opened the app for weeks.',
    fix: { kind: 'settings', target: 'hibernation', label: 'Open app settings' },
    path: 'Settings › Apps › findmyperson › Pause app activity if unused',
  },
  oem_restriction_suspected: {
    title: 'Your phone may be closing the app',
    body: 'Capture wakes that should have happened did not. Some phone makers stop background apps: allow autostart and remove battery limits for this app.',
    fix: { kind: 'settings', target: 'battery', label: 'Open autostart settings' },
  },
  background_refresh_off: {
    title: 'Background App Refresh is off',
    body: 'Turn it on for this app so capture can resume after the phone restarts the app.',
    fix: { kind: 'settings', target: 'app', label: 'Enable Background App Refresh' },
    path: 'Settings › General › Background App Refresh › findmyperson',
  },
  low_power_mode: {
    title: 'Low Power Mode is on',
    body: 'It pauses background location. Capture resumes when you turn Low Power Mode off.',
    fix: { kind: 'settings', target: 'app', label: 'Open settings' },
    path: 'Settings › Battery › Low Power Mode',
  },
};

/** Most blocking first; the first raised flag is the one the Home card names. */
export const FLAG_PRIORITY: readonly HealthFlag[] = [
  'store_unusable',
  'location_services_off',
  'background_permission_missing',
  'precise_location_off',
  'service_not_running',
  'battery_optimisation_active',
  'hibernation_not_exempt',
  'oem_restriction_suspected',
  'background_refresh_off',
  'low_power_mode',
];

export function sortFlags(flags: readonly HealthFlag[]): HealthFlag[] {
  return [...flags].sort((a, b) => FLAG_PRIORITY.indexOf(a) - FLAG_PRIORITY.indexOf(b));
}
