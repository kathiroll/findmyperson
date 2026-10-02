import type { ReactNode } from 'react';
import { Animated, Modal, Pressable, View } from 'react-native';
import { useEnterValue } from './motion';
import { colors, motion, radii, spacing } from './theme';
import { Text } from './Text';

export type BottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
};

const SHEET_TRAVEL = 600;

/** Modal sheet (deactivate-report): scrim fades in over 300ms, sheet slides up over 550ms. */
export function BottomSheet({ visible, onClose, title, description, children }: BottomSheetProps) {
  const scrim = useEnterValue(visible, motion.duration.fade);
  const sheet = useEnterValue(visible, motion.duration.sheet);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: colors.scrim,
            opacity: scrim,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss"
            onPress={onClose}
            style={{ flex: 1 }}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          accessibilityLabel={title}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radii.sheet,
            borderTopRightRadius: radii.sheet,
            paddingTop: spacing[12],
            paddingHorizontal: 24,
            paddingBottom: spacing[28],
            gap: spacing[20],
            transform: [
              {
                translateY: sheet.interpolate({
                  inputRange: [0, 1],
                  outputRange: [SHEET_TRAVEL, 0],
                }),
              },
            ],
          }}
        >
          <View
            accessibilityElementsHidden
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.borderMap,
            }}
          />
          <View style={{ gap: spacing[8] }}>
            <Text variant="heading" accessibilityRole="header">
              {title}
            </Text>
            {description ? (
              <Text variant="bodySmall" color="muted">
                {description}
              </Text>
            ) : null}
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}
