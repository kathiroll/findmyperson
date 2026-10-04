import type { LinkingOptions } from '@react-navigation/native';

/**
 * Root stack. Later screen tasks target these route names. There is no tab bar (the v2 mockups
 * have none): `Home` is the root screen after onboarding and reaches `History`, `Settings` and
 * `ReportForm` through its hamburger menu. `LiveReport`, `CaptureHealth` and `Bystander` are
 * pushed from Home or a deep link.
 */
export type RootStackParamList = {
  Onboarding: undefined;
  Home: undefined;
  History: undefined;
  Settings: undefined;
  CaptureHealth: undefined;
  /** Staged location permission flow (C2.6). Opened from onboarding, Settings and capture health. */
  PermissionFlow: undefined;
  ReportForm: undefined;
  LiveReport: { reportId: string };
  Bystander: { matchId: string };
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}

export const linkingPrefix = 'findmyperson://';

/**
 * Deep links. `match/<matchId>` is what a match-notification tap opens (bystander flow);
 * `report/<reportId>` is what a reply notification opens for the reporter (live report).
 */
export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: [linkingPrefix],
  config: {
    screens: {
      Onboarding: 'welcome',
      Home: 'home',
      History: 'history',
      Settings: 'settings',
      CaptureHealth: 'capture-health',
      PermissionFlow: 'permissions',
      ReportForm: 'new-report',
      LiveReport: 'report/:reportId',
      Bystander: 'match/:matchId',
    },
  },
};

/** URL to attach to a match notification so a tap lands on the bystander screen. */
export const matchNotificationUrl = (matchId: string) =>
  `${linkingPrefix}match/${encodeURIComponent(matchId)}`;

/** URL to attach to a reply notification so a tap lands on the reporter's live report. */
export const reportNotificationUrl = (reportId: string) =>
  `${linkingPrefix}report/${encodeURIComponent(reportId)}`;
