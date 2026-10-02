import { useEffect, useRef } from 'react';
import { Animated, View } from 'react-native';
import { standardEasing, useReducedMotion } from './motion';
import { colors, motion, radii, spacing } from './theme';

export type StepProgressProps = {
  /** 1-based current step. */
  step: number;
  total: number;
};

/** Segmented bar under the report-flow header; the newest segment grows in from the left. */
export function StepProgress({ step, total }: StepProgressProps) {
  const reduced = useReducedMotion();
  const grow = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) {
      grow.setValue(1);
      return undefined;
    }
    grow.setValue(0);
    const animation = Animated.timing(grow, {
      toValue: 1,
      duration: motion.duration.grow,
      easing: standardEasing,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [step, reduced, grow]);

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${step} of ${total}`}
      accessibilityValue={{ min: 1, max: total, now: step }}
      style={{ marginTop: spacing[8], marginHorizontal: 24, flexDirection: 'row', gap: spacing[6] }}
    >
      {Array.from({ length: total }, (_, index) => {
        const done = index < step;
        const current = index === step - 1;
        return (
          <Animated.View
            key={index}
            style={{
              flex: 1,
              height: 4,
              borderRadius: radii.progress,
              backgroundColor: done ? colors.primary : colors.progressOff,
              transformOrigin: 'left center',
              transform: current ? [{ scaleX: grow }] : [],
            }}
          />
        );
      })}
    </View>
  );
}
