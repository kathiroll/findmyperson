import { Animated, View } from 'react-native';
import { useLoopingValue } from './motion';
import { colors, motion, type ColorName } from './theme';

export type PulsingDotProps = {
  color?: ColorName;
  size?: number;
  /** `false` draws the solid dot with no halo (the "working normally" dot on a report screen). */
  pulse?: boolean;
};

/**
 * Live indicator: a solid dot with a halo that grows to 3.4x and fades over 70% of a 2.4s cycle,
 * then rests. Decorative; pair it with text that names the state.
 */
export function PulsingDot({ color = 'success', size = 10, pulse = true }: PulsingDotProps) {
  const progress = useLoopingValue({
    duration: motion.duration.pulse * motion.pulse.activeShare,
    rest: motion.duration.pulse * (1 - motion.pulse.activeShare),
  });
  const dot = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: colors[color],
  } as const;

  return (
    <View
      style={{ width: size, height: size, flexShrink: 0 }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {pulse ? (
        <Animated.View
          testID="pulsing-dot-halo"
          style={[
            dot,
            {
              opacity: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [motion.pulse.startOpacity, 0],
              }),
              transform: [
                {
                  scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, motion.pulse.scale],
                  }),
                },
              ],
            },
          ]}
        />
      ) : null}
      <View style={dot} />
    </View>
  );
}
