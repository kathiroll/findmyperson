import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback } from 'react';
import { Button } from '../design-system';
import { CaptureHealthDiagnostics, CaptureHealthStatus } from '../capture-health';
import { OnboardingScreen } from '../onboarding';
import { PermissionFlowScreen } from '../permissions';
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
    <PlaceholderScreen
      testID="screen-ReportForm"
      header={{
        variant: 'back',
        title: 'Report a missing person',
        onBackPress: navigation.goBack,
        trailing: 'Step 1 of 2',
      }}
      title="Report a missing person"
      description="Report form: your details, then the missing person."
    />
  );
}

export function LiveReportScreen({ navigation, route }: RootProps<'LiveReport'>) {
  return (
    <PlaceholderScreen
      testID="screen-LiveReport"
      header={{ variant: 'back', title: 'Your report', onBackPress: navigation.goBack }}
      title="Live report"
      description={`Live report ${route.params.reportId}: status, replies, options and deactivate.`}
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
