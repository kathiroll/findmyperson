// Test doubles for the native-only pieces of the navigation stack. The real graph in
// AppNavigator.tsx is rendered against these: the routers, linking, params and screens are
// React Navigation's own; only the native view containers are replaced.
import {
  StackRouter,
  createNavigatorFactory,
  useNavigationBuilder,
} from '@react-navigation/native';
import { createElement, type ReactNode } from 'react';

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

export const createNativeStackNavigator = () => createNavigatorFactory(StackView as never)();

export const SafeAreaProvider = ({ children }: { children?: ReactNode }) => children;
export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
