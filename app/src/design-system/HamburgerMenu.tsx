import { Animated, Modal, Pressable, View } from 'react-native';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { Rise, useEnterValue, useLoopingValue } from './motion';
import { Text } from './Text';
import { colors, motion, sizes, spacing } from './theme';

export type HamburgerMenuItem = {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
};

export type HamburgerMenuProps = {
  visible: boolean;
  onClose: () => void;
  items: HamburgerMenuItem[];
  /** Small print pinned to the bottom ("Free, open source and non-commercial."). */
  footnote?: string;
};

/** Ring radii (px) and resting opacity for the static rings drawn behind the menu. */
const restingRings = [
  { size: 120, opacity: 0.3 },
  { size: 240, opacity: 0.16 },
] as const;
const sweepingRings = [0, 0.5] as const;
const ringSize = 360;

function SweepingRing({ phase }: { phase: number }) {
  const progress = useLoopingValue({ duration: motion.duration.ring, phase, linear: true });
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: -ringSize / 2,
        top: -ringSize / 2,
        width: ringSize,
        height: ringSize,
        borderRadius: ringSize / 2,
        borderWidth: 1.5,
        borderColor: colors.white,
        opacity: progress.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0, 0.6, 0] }),
        transform: [
          { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.06, 1] }) },
        ],
      }}
    />
  );
}

/** Radar rings anchored bottom-right, as on the menu artboard. Purely decorative. */
function Rings() {
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', right: 0, bottom: 204, width: 0, height: 0 }}
    >
      {restingRings.map(({ size, opacity }) => (
        <View
          key={size}
          style={{
            position: 'absolute',
            left: -size / 2,
            top: -size / 2,
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 1.5,
            borderColor: colors.white,
            opacity,
          }}
        />
      ))}
      {sweepingRings.map((phase) => (
        <SweepingRing key={phase} phase={phase} />
      ))}
    </View>
  );
}

/**
 * Full-screen blue navigation menu opened from the header hamburger. Fades in over 300ms, the
 * rows rise in with a stagger. Rendered in a transparent Modal so it sits above any screen.
 */
export function HamburgerMenu({ visible, onClose, items, footnote }: HamburgerMenuProps) {
  const fade = useEnterValue(visible, motion.duration.fade);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Animated.View
        accessibilityViewIsModal
        style={{ flex: 1, backgroundColor: colors.primary, opacity: fade }}
      >
        <Rings />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: spacing[12],
            paddingBottom: spacing[8],
            paddingLeft: sizes.gutter,
            paddingRight: spacing[16],
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[10] }}>
            <Icon name="logo" size={22} color="white" />
            <Text variant="brand" color="white">
              findmyperson
            </Text>
          </View>
          <IconButton
            icon="close"
            accessibilityLabel="Close menu"
            color="white"
            pressedColor={colors.primaryPressed}
            onPress={onClose}
          />
        </View>

        <View
          accessibilityRole="menu"
          style={{ paddingTop: sizes.gutter, paddingHorizontal: sizes.gutter }}
        >
          {items.map((item, index) => (
            <Rise key={item.label} delay={80 * (index + 1)}>
              <Pressable
                accessibilityRole="menuitem"
                accessibilityLabel={item.accessibilityLabel ?? item.label}
                onPress={item.onPress}
                style={({ pressed }) => ({
                  minHeight: index === 0 ? sizes.menuRowFirst : sizes.menuRow,
                  paddingVertical: spacing[16],
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: spacing[16],
                  borderTopWidth: 1,
                  borderBottomWidth: index === items.length - 1 ? 1 : 0,
                  borderColor: colors.onBlueDivider,
                  backgroundColor: pressed ? colors.primaryPressed : 'transparent',
                })}
              >
                <Text variant="menuItem" color="white" style={{ flexShrink: 1 }}>
                  {item.label}
                </Text>
                <Icon name="arrow" size={24} color="white" />
              </Pressable>
            </Rise>
          ))}
        </View>

        {footnote ? (
          <Text
            variant="bodySmall"
            color="white"
            style={{ marginTop: 'auto', marginHorizontal: sizes.gutter, marginBottom: spacing[36] }}
          >
            {footnote}
          </Text>
        ) : null}
      </Animated.View>
    </Modal>
  );
}
