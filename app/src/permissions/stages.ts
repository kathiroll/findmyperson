import type {
  CapturePlatform,
  CaptureStatus,
  HealthFlag,
  SettingsTarget,
} from '@findmyperson/native-location-capture';

/**
 * Where the permission flow is, derived only from what `getStatus` reports plus whether the user
 * chose to stay on "while using the app". Nothing here is stored: the OS is the source of truth,
 * so a change made in system settings is picked up the next time the status is read.
 *
 *   disclosure  Android, never asked. Play's prominent disclosure, before the first runtime prompt.
 *   purpose     iOS, never asked. Plain-language purpose, then the When-In-Use prompt.
 *   upgrade     While-using granted; the app explains why "all the time" matters and offers it.
 *   limited     While-using granted and the user declined the upgrade: what that costs.
 *   complete    "All the time" granted (device remedies may still apply, see `remedies`).
 *   denied      The platform will not ask again; only system settings can change it.
 *   restricted  Device policy; the user cannot change it from here.
 */
export type PermissionStage =
  'disclosure' | 'purpose' | 'upgrade' | 'limited' | 'complete' | 'denied' | 'restricted';

export const PERMISSION_STAGES: readonly PermissionStage[] = [
  'disclosure',
  'purpose',
  'upgrade',
  'limited',
  'complete',
  'denied',
  'restricted',
];

export function permissionStage(
  status: Pick<CaptureStatus, 'permission'>,
  platform: CapturePlatform,
  declinedUpgrade: boolean,
): PermissionStage {
  switch (status.permission) {
    case 'undetermined':
      return platform === 'android' ? 'disclosure' : 'purpose';
    case 'denied':
      return 'denied';
    case 'restricted':
      return 'restricted';
    case 'foreground_only':
      return declinedUpgrade ? 'limited' : 'upgrade';
    case 'always':
      return 'complete';
  }
}

/** A fix for a device condition, shown only while the matching health flag is raised. */
export type Remedy = {
  flag: HealthFlag;
  title: string;
  body: string;
  action: string;
  target: SettingsTarget;
};

const REMEDIES: Partial<Record<HealthFlag, Omit<Remedy, 'flag'>>> = {
  location_services_off: {
    title: 'Location is switched off on this phone',
    body: 'Nothing can be captured until location is turned back on in system settings.',
    action: 'Open settings',
    target: 'app',
  },
  precise_location_off: {
    title: 'Only approximate location is allowed',
    body: 'Matching works best with precise location. Switch "Precise" on for this app.',
    action: 'Open settings',
    target: 'app',
  },
  battery_optimisation_active: {
    title: 'Battery saver may stop capture',
    body: 'Let the app run in the background without battery restrictions, and allow autostart if your phone has that option.',
    action: 'Open battery settings',
    target: 'battery',
  },
  oem_restriction_suspected: {
    title: 'Your phone may be closing the app',
    body: 'Some phone makers stop background apps. Allow autostart and remove battery limits for this app.',
    action: 'Open autostart settings',
    target: 'battery',
  },
  hibernation_not_exempt: {
    title: 'App activity may be paused when unused',
    body: 'Turn off "Pause app activity if unused" so capture keeps running when you have not opened the app for weeks.',
    action: 'Open app settings',
    target: 'hibernation',
  },
  background_refresh_off: {
    title: 'Background App Refresh is off',
    body: 'Turn it on for this app so capture can resume after the phone restarts the app.',
    action: 'Open settings',
    target: 'app',
  },
  low_power_mode: {
    title: 'Low Power Mode is on',
    body: 'It pauses background location. Capture resumes when you turn Low Power Mode off.',
    action: 'Open settings',
    target: 'app',
  },
};

/** Remedies are only offered once some location permission exists to be made effective. */
export function remedies(status: Pick<CaptureStatus, 'permission' | 'health'>): Remedy[] {
  if (status.permission !== 'always' && status.permission !== 'foreground_only') {
    return [];
  }
  return status.health.flatMap((flag) => {
    const remedy = REMEDIES[flag];
    return remedy ? [{ flag, ...remedy }] : [];
  });
}
