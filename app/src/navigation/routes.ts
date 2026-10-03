import type { LinkingOptions } from '@react-navigation/native';
import type { NavigatorScreenParams } from '@react-navigation/native';

/** Bottom tabs, in mockup order (`Home.dc.html`): Home, History, Settings. */
export type TabParamList = {
  Home: undefined;
  History: undefined;
  Settings: undefined;
};

/**
 * Root stack. Later screen tasks target these route names; the tab screens live under `Main`.
 * `ReportForm`, `LiveReport`, `CaptureHealth` and `Bystander` are pushed from Home or a deep link,
 * never from the tab bar.
 */
export type RootStackParamList = {
  Onboarding: undefined;
  Main: NavigatorScreenParams<TabParamList> | undefined;
  CaptureHealth: undefined;
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
      Main: { screens: { Home: 'home', History: 'history', Settings: 'settings' } },
      CaptureHealth: 'capture-health',
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
