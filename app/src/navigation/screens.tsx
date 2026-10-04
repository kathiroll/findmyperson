import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Button } from '../design-system';
import { CaptureHealthDiagnostics, CaptureHealthStatus } from '../capture-health';
import { OnboardingScreen } from '../onboarding';
import { PermissionFlowScreen } from '../permissions';
import { ReportSubmitScreen } from '../report';
import { SettingsScreen } from '../settings';
import { PlaceholderScreen } from './PlaceholderScreen';
import type { RootStackParamList, TabParamList } from './routes';

// Each screen below is a stub. A later screen task replaces the body (and drops the temporary
// navigation buttons) but keeps the route name and params from routes.ts.

type RootProps<R extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, R>;
type TabProps<R extends keyof TabParamList> = CompositeScreenProps<
  BottomTabScreenProps<TabParamList, R>,
  NativeStackScreenProps<RootStackParamList>
>;

export function OnboardingRoute({ navigation }: RootProps<'Onboarding'>) {
  const subscribeFocus = useCallback(
    (onFocus: () => void) => navigation.addListener('focus', onFocus),
    [navigation],
  );
  const onDone = useCallback(() => navigation.replace('Main'), [navigation]);
  return (
    <OnboardingScreen
      onEnable={() => navigation.navigate('PermissionFlow')}
      onDone={onDone}
      subscribeFocus={subscribeFocus}
    />
  );
}

export function HomeScreen({ navigation }: TabProps<'Home'>) {
  return (
    <PlaceholderScreen
      testID="screen-Home"
      header={{ variant: 'brand' }}
      title="Home"
      description="Home: capture-health status, report entry point, live report card."
    >
      <CaptureHealthStatus
        onOpenPermissionFlow={() => navigation.navigate('PermissionFlow')}
        onOpenDiagnostics={() => navigation.navigate('CaptureHealth')}
      />
      <Button
        label="Report a missing person"
        icon="plus"
        onPress={() => navigation.navigate('ReportForm')}
      />
      <Button
        label="Capture health"
        variant="tint"
        onPress={() => navigation.navigate('CaptureHealth')}
      />
      <Button
        label="My live report"
        variant="ghost"
        onPress={() => navigation.navigate('LiveReport', { reportId: 'preview' })}
      />
      <Button
        label="Preview a match"
        variant="ghost"
        onPress={() => navigation.navigate('Bystander', { matchId: 'preview' })}
      />
    </PlaceholderScreen>
  );
}

export function HistoryScreen() {
  return (
    <PlaceholderScreen
      testID="screen-History"
      header={{ variant: 'brand' }}
      title="History"
      description="History: past matches and reports. Not in the v2 mockups yet."
    />
  );
}

export function SettingsRoute({ navigation }: TabProps<'Settings'>) {
  return (
    <SettingsScreen
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
