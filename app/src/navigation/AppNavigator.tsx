import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { Ref } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { LocationCapture } from '@findmyperson/native-location-capture';
import { useMemo } from 'react';
import { colors, fontFamilies } from '../design-system';
import { CaptureProvider, loadNativeCapture } from '../permissions';
import { DataStoreProvider, type DataStore } from '../store';
import { linking, type RootStackParamList, type TabParamList } from './routes';
import {
  BystanderScreen,
  CaptureHealthScreen,
  HistoryScreen,
  HomeScreen,
  LiveReportScreen,
  OnboardingRoute,
  PermissionFlowRoute,
  ReportFormScreen,
  SettingsRoute,
} from './screens';
import { TabIcon } from './TabIcon';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: { fontFamily: fontFamilies.body, fontSize: 11 },
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarIcon: ({ color }) => <TabIcon route={route.name} color={color} />,
      })}
    >
      <Tabs.Screen name="Home" component={HomeScreen} />
      <Tabs.Screen name="History" component={HistoryScreen} />
      <Tabs.Screen name="Settings" component={SettingsRoute} />
    </Tabs.Navigator>
  );
}

export type AppNavigatorProps = {
  /** First screen when no deep link is being opened. The onboarding gate is a later task. */
  initialRouteName?: keyof RootStackParamList;
  navigationRef?: Ref<NavigationContainerRef<RootStackParamList>>;
  /** The capture module. Production leaves it out and gets the real native module. */
  capture?: LocationCapture;
  /** What Settings may do to the on-device store. Production leaves it out and gets the real one. */
  dataStore?: DataStore;
};

/** The whole app shell: root stack, bottom tabs and deep-link handling. */
export function AppNavigator({
  initialRouteName = 'Onboarding',
  navigationRef,
  capture,
  dataStore,
}: AppNavigatorProps) {
  const module = useMemo(() => capture ?? loadNativeCapture(), [capture]);
  return (
    <CaptureProvider capture={module}>
      <DataStoreProvider {...(dataStore ? { dataStore } : {})}>
        <SafeAreaProvider>
          <NavigationContainer {...(navigationRef ? { ref: navigationRef } : {})} linking={linking}>
            <Stack.Navigator
              initialRouteName={initialRouteName}
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Screen name="Onboarding" component={OnboardingRoute} />
              <Stack.Screen name="Main" component={MainTabs} />
              <Stack.Screen name="CaptureHealth" component={CaptureHealthScreen} />
              <Stack.Screen name="PermissionFlow" component={PermissionFlowRoute} />
              <Stack.Screen name="ReportForm" component={ReportFormScreen} />
              <Stack.Screen name="LiveReport" component={LiveReportScreen} />
              <Stack.Screen
                name="Bystander"
                component={BystanderScreen}
                options={{ presentation: 'modal' }}
              />
            </Stack.Navigator>
          </NavigationContainer>
        </SafeAreaProvider>
      </DataStoreProvider>
    </CaptureProvider>
  );
}
