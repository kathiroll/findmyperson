/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal react-native stand-in for vitest: host components are plain string elements and
// Animated records what was started so tests can assert real animations are wired up.
import { createElement, type ReactNode } from 'react';

const host = (name: string) => {
  const Component = ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement(name, props, children);
  Component.displayName = name;
  return Component;
};

export const View = host('View');
export const Text = host('Text');
export const Image = host('Image');
export const ScrollView = host('ScrollView');
export const TextInput = host('TextInput');
export const Pressable = ({ style, children, ...props }: any) =>
  createElement(
    'Pressable',
    { ...props, style: typeof style === 'function' ? style({ pressed: false }) : style },
    typeof children === 'function' ? children({ pressed: false }) : children,
  );
export const Modal = ({ visible, children, ...props }: any) =>
  visible ? createElement('Modal', props, children) : null;

export const StyleSheet = { create: <T,>(styles: T) => styles, hairlineWidth: 1 };

export const animationLog = { started: 0, stopped: 0, loops: 0, reduceMotion: false };

class Value {
  constructor(public value: number) {}
  setValue(next: number) {
    this.value = next;
  }
  interpolate(config: { inputRange: number[]; outputRange: number[] }) {
    return { interpolation: config };
  }
}

const handle = () => ({
  start: () => {
    animationLog.started += 1;
  },
  stop: () => {
    animationLog.stopped += 1;
  },
});

export const Animated = {
  Value,
  View: host('Animated.View'),
  Text: host('Animated.Text'),
  timing: () => handle(),
  sequence: (animations: unknown[]) => ({ ...handle(), animations }),
  delay: (ms: number) => ({ ...handle(), ms }),
  loop: (animation: unknown) => {
    animationLog.loops += 1;
    return { ...handle(), animation };
  },
};

export const Easing = { bezier: () => (t: number) => t, linear: (t: number) => t };

export const AccessibilityInfo = {
  isReduceMotionEnabled: () => Promise.resolve(animationLog.reduceMotion),
  addEventListener: () => ({ remove: () => undefined }),
};

export type StyleProp<T> = T;
export type ViewStyle = Record<string, unknown>;
export type ViewProps = Record<string, unknown>;
export type TextProps = Record<string, unknown>;
export type TextInputProps = Record<string, any>;
export type ImageSourcePropType = unknown;

// Surface used by @react-navigation/native; Linking.initialUrl is set per test.
export const Linking = {
  initialUrl: null as string | null,
  getInitialURL: () => Promise.resolve(Linking.initialUrl),
  addEventListener: () => ({ remove: () => undefined }),
};
export const Platform = { OS: 'android', select: (spec: any) => spec.android ?? spec.default };
export const BackHandler = {
  addEventListener: () => ({ remove: () => undefined }),
  removeEventListener: () => undefined,
};
export const I18nManager = { isRTL: false, getConstants: () => ({ isRTL: false }) };
export const Dimensions = { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) };
