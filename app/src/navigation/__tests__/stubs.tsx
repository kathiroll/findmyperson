// Test doubles for the native-only pieces of the navigation stack. The real graph in
// AppNavigator.tsx is rendered against these: the routers, linking, params and screens are
// React Navigation's own; only the native view containers are replaced.
import {
  StackRouter,
  TabRouter,
  createNavigatorFactory,
  useNavigationBuilder,
} from '@react-navigation/native';
import { createElement, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';

function StackView({ children, ...options }: { children?: ReactNode } & Record<string, unknown>) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(
    StackRouter as never,
    {
      children,
      ...options,
    } as never,
  );
  const route = state.routes[state.index]!;
  return createElement(NavigationContent, null, descriptors[route.key]!.render());
}

function TabView({ children, ...options }: { children?: ReactNode } & Record<string, unknown>) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder(
    TabRouter as never,
    {
      children,
      ...options,
    } as never,
  );
  const route = state.routes[state.index]!;
  return createElement(
    NavigationContent,
    null,
    createElement(View, { testID: 'tab-bar' }, [
      ...state.routes.map((r) =>
        createElement(Pressable, {
          key: r.key,
          accessibilityRole: 'tab',
          accessibilityLabel: r.name,
          accessibilityState: { selected: r.key === route.key },
          onPress: () => navigation.navigate(r.name as never),
        }),
      ),
    ]),
    descriptors[route.key]!.render(),
  );
}

export const createNativeStackNavigator = () => createNavigatorFactory(StackView as never)();
export const createBottomTabNavigator = () => createNavigatorFactory(TabView as never)();

export const SafeAreaProvider = ({ children }: { children?: ReactNode }) => children;
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
