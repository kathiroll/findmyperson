import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { Ref } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors, fontFamilies } from '../design-system';
import { linking, type RootStackParamList, type TabParamList } from './routes';
import {
  BystanderScreen,
  CaptureHealthScreen,
  HistoryScreen,
  HomeScreen,
  LiveReportScreen,
  OnboardingScreen,
  ReportFormScreen,
  SettingsScreen,
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
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

export type AppNavigatorProps = {
  /** First screen when no deep link is being opened. The onboarding gate is a later task. */
  initialRouteName?: keyof RootStackParamList;
  navigationRef?: Ref<NavigationContainerRef<RootStackParamList>>;
};

/** The whole app shell: root stack, bottom tabs and deep-link handling. */
export function AppNavigator({
  initialRouteName = 'Onboarding',
  navigationRef,
}: AppNavigatorProps) {
  return (
    <SafeAreaProvider>
      <NavigationContainer {...(navigationRef ? { ref: navigationRef } : {})} linking={linking}>
        <Stack.Navigator
          initialRouteName={initialRouteName}
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
          <Stack.Screen name="Main" component={MainTabs} />
          <Stack.Screen name="CaptureHealth" component={CaptureHealthScreen} />
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
  );
}
