import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { CaptureHealthDiagnostics } from '../capture-health';
import { HomeScreen } from '../home';
import { OnboardingScreen } from '../onboarding';
import { PermissionFlowScreen } from '../permissions';
import { ReportSubmitScreen } from '../report';
import { SettingsScreen } from '../settings';
import { PlaceholderScreen } from './PlaceholderScreen';
import type { RootStackParamList } from './routes';

// Each screen below is a stub. A later screen task replaces the body (and drops the temporary
// navigation buttons) but keeps the route name and params from routes.ts.

type RootProps<R extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, R>;

export function OnboardingRoute({ navigation }: RootProps<'Onboarding'>) {
  const subscribeFocus = useCallback(
    (onFocus: () => void) => navigation.addListener('focus', onFocus),
    [navigation],
  );
  const onDone = useCallback(() => navigation.replace('Home'), [navigation]);
  return (
    <OnboardingScreen
      onEnable={() => navigation.navigate('PermissionFlow')}
      onDone={onDone}
      subscribeFocus={subscribeFocus}
    />
  );
}

export function HomeRoute({ navigation }: RootProps<'Home'>) {
  // The menu is Home's only navigation: the mockups have no tab bar and no report button.
  const menuItems = [
    { label: 'Report a missing person', onPress: () => navigation.navigate('ReportForm') },
    { label: 'History', onPress: () => navigation.navigate('History') },
    { label: 'Settings', onPress: () => navigation.navigate('Settings') },
  ];
  return (
    <HomeScreen
      menuItems={menuItems}
      onOpenPermissionFlow={() => navigation.navigate('PermissionFlow')}
      onOpenCaptureHealth={() => navigation.navigate('CaptureHealth')}
      onOpenLiveReport={(reportId) => navigation.navigate('LiveReport', { reportId })}
    />
  );
}

export function HistoryScreen({ navigation }: RootProps<'History'>) {
  return (
    <PlaceholderScreen
      testID="screen-History"
      header={{ variant: 'back', title: 'History', onBackPress: navigation.goBack }}
      title="History"
      description="History: past matches and reports. Not in the v2 mockups yet."
    />
  );
}

export function SettingsRoute({ navigation }: RootProps<'Settings'>) {
  return (
    <SettingsScreen
      onBack={navigation.goBack}
      onOpenCaptureHealth={() => navigation.navigate('CaptureHealth')}
      onOpenPermissionFlow={() => navigation.navigate('PermissionFlow')}
    />
  );
}

export function CaptureHealthScreen({ navigation }: RootProps<'CaptureHealth'>) {
  return (
    <CaptureHealthDiagnostics
      onBack={navigation.goBack}
      onOpenPermissionFlow={() => navigation.navigate('PermissionFlow')}
    />
  );
}

export function PermissionFlowRoute({ navigation }: RootProps<'PermissionFlow'>) {
  return <PermissionFlowScreen onClose={navigation.goBack} />;
}

export function ReportFormScreen({ navigation }: RootProps<'ReportForm'>) {
  return (
    <ReportSubmitScreen
      onBack={navigation.goBack}
      // replace: Back from the live report must not return to a form that was already sent.
      onSubmitted={(reportId) => navigation.replace('LiveReport', { reportId })}
    />
  );
}

export function LiveReportScreen({ navigation, route }: RootProps<'LiveReport'>) {
  // Placeholder until the active-report screen (R4.3) lands. The only truthful thing to say is
  // that the report is held for review: nothing is broadcast until the operator releases it.
  return (
    <PlaceholderScreen
      testID="screen-LiveReport"
      header={{ variant: 'back', title: 'Your report', onBackPress: navigation.goBack }}
      title="Submitted, under review"
      description={`Your report (${route.params.reportId}) has been submitted and is being reviewed. Nothing is shared with anyone until it is approved, and we may call you first. You'll see its status here once the full report screen is ready.`}
    />
  );
}

export function BystanderScreen({ navigation, route }: RootProps<'Bystander'>) {
  return (
    <PlaceholderScreen
      testID="screen-Bystander"
      header={{ variant: 'close', title: 'Possible match', onClosePress: navigation.goBack }}
      title="Possible match"
      description={`Bystander match ${route.params.matchId}: private match notice and share-or-stay-anonymous choice.`}
    />
  );
}
