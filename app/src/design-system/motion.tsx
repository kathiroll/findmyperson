import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';
import { motion } from './theme';

export const standardEasing = Easing.bezier(...motion.easing);

/** Mirrors the OS "reduce motion" setting; animations render in their resting state when true. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

type LoopOptions = {
  duration: number;
  /** Rest period after each pass, in ms. */
  rest?: number;
  /** Start part-way through the cycle (0-1), like a negative CSS animation-delay. */
  phase?: number;
  easing?: (value: number) => number;
  linear?: boolean;
};

/**
 * A 0 -> 1 value that loops forever on the native driver. Stays at `1` (the resting end of the
 * cycle, which every consumer maps to "invisible") when reduce-motion is on.
 */
export function useLoopingValue({
  duration,
  rest = 0,
  phase = 0,
  easing = standardEasing,
  linear = false,
}: LoopOptions): Animated.Value {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(reduced ? 1 : phase)).current;

  useEffect(() => {
    if (reduced) {
      value.setValue(1);
      return undefined;
    }
    const curve = linear ? Easing.linear : easing;
    const pass = (from: number) =>
      Animated.timing(value, {
        toValue: 1,
        duration: duration * (1 - from),
        easing: curve,
        useNativeDriver: true,
      });
    const cycle = Animated.sequence([pass(0), ...(rest > 0 ? [Animated.delay(rest)] : [])]);
    value.setValue(phase);
    // Finish the partial first pass, then loop whole cycles (value resets to 0 each iteration).
    const running =
      phase > 0 ? Animated.sequence([pass(phase), Animated.loop(cycle)]) : Animated.loop(cycle);
    running.start();
    return () => running.stop();
  }, [reduced, value, duration, rest, phase, easing, linear]);

  return value;
}

type RiseProps = {
  children: ReactNode;
  /** Stagger in ms, like the mockups' `animation-delay`. */
  delay?: number;
  style?: StyleProp<ViewStyle>;
};

/** Entrance used on every screen: fade up 14px over 700ms. */
export function Rise({ children, delay = 0, style }: RiseProps) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return undefined;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.duration.rise,
      delay,
      easing: standardEasing,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduced, progress, delay]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [motion.riseDistance, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** One-shot 0 -> 1 timing value, for fades, pops and sheets. */
export function useEnterValue(active: boolean, duration: number, delay = 0): Animated.Value {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      value.setValue(0);
      return undefined;
    }
    if (reduced) {
      value.setValue(1);
      return undefined;
    }
    value.setValue(0);
    const animation = Animated.timing(value, {
      toValue: 1,
      duration,
      delay,
      easing: standardEasing,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [active, reduced, value, duration, delay]);
  return value;
}
