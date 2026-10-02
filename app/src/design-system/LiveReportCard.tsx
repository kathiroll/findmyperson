import { useState, type ReactNode } from 'react';
import { Animated, Image, Pressable, View, type ImageSourcePropType } from 'react-native';
import { Card } from './Card';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';
import { IconChip } from './IconChip';
import { useEnterValue } from './motion';
import { PulsingDot } from './PulsingDot';
import { Text } from './Text';
import { colors, elevation, motion, radii, spacing } from './theme';

export type LiveReportMenuItem = {
  label: string;
  onPress: () => void;
  icon?: IconName;
  /** Red label and glyph, for irreversible actions ("Deactivate report"). */
  destructive?: boolean;
};

export type LiveReportCardProps = {
  name: string;
  /** Second line under the name, e.g. "Last seen Sep 18, 6:30 PM" then the place. */
  details: string[];
  photo?: ImageSourcePropType;
  /** "Your report" by default. */
  statusLabel?: string;
  /** Hides the pulsing dot and "Live" announcement once a report is no longer broadcasting. */
  live?: boolean;
  menuItems: LiveReportMenuItem[];
  /** Controlled menu state; leave undefined for the card to manage it. */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  /** The replies section: "No replies yet" copy or the reply list. */
  children?: ReactNode;
  testID?: string;
};

function MenuPopover({ items, onSelect }: { items: LiveReportMenuItem[]; onSelect: () => void }) {
  const enter = useEnterValue(true, motion.duration.pop);
  return (
    <Animated.View
      accessibilityRole="menu"
      style={[
        {
          position: 'absolute',
          top: 60,
          right: 12,
          width: 236,
          padding: spacing[6],
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radii.popover,
          opacity: enter,
          transform: [
            { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) },
            { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
          ],
        },
        elevation.popover,
      ]}
    >
      {items.map((item) => (
        <Pressable
          key={item.label}
          accessibilityRole="menuitem"
          accessibilityLabel={item.label}
          onPress={() => {
            onSelect();
            item.onPress();
          }}
          style={({ pressed }) => ({
            height: 48,
            paddingHorizontal: spacing[12],
            borderRadius: radii.menuItem,
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing[10],
            backgroundColor: pressed ? colors.tint : 'transparent',
          })}
        >
          <Icon
            name={item.icon ?? 'minusCircle'}
            size={20}
            color={item.destructive ? 'danger' : 'ink'}
          />
          <Text variant="itemTitle" color={item.destructive ? 'danger' : 'ink'}>
            {item.label}
          </Text>
        </Pressable>
      ))}
    </Animated.View>
  );
}

/**
 * The live-report card on Home: pulsing green dot beside "Your report", a 3-dot options menu
 * (pop-in popover), the person's photo/name/last-seen, then a slot for replies.
 */
export function LiveReportCard({
  name,
  details,
  photo,
  statusLabel = 'Your report',
  live = true,
  menuItems,
  menuOpen: controlledOpen,
  onMenuOpenChange,
  children,
  testID,
}: LiveReportCardProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onMenuOpenChange?.(next);
  };

  return (
    <Card
      testID={testID}
      accessibilityLabel={statusLabel}
      style={{ padding: spacing[20], gap: spacing[16] }}
    >
      <View style={{ gap: spacing[4] }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: -8,
            marginRight: -8,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[12] }}>
            {live ? <PulsingDot /> : null}
            <Text
              variant="eyebrow"
              color="muted"
              accessibilityLabel={live ? `Live. ${statusLabel}` : statusLabel}
            >
              {statusLabel}
            </Text>
          </View>
          <IconButton
            testID="live-report-menu-button"
            icon="dots"
            size={44}
            iconSize={22}
            accessibilityLabel="Report options"
            expanded={open}
            onPress={() => setOpen(!open)}
          />
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[16] }}>
          {photo ? (
            <Image
              source={photo}
              accessibilityLabel={`Photo of ${name}`}
              style={{ width: 64, height: 64, borderRadius: radii.iconChip }}
            />
          ) : (
            <IconChip icon="person" accessibilityLabel="Photo placeholder" />
          )}
          <View style={{ flex: 1, gap: spacing[4] }}>
            <Text variant="heading" accessibilityRole="header">
              {name}
            </Text>
            {details.map((line) => (
              <Text key={line} variant="caption" color="muted">
                {line}
              </Text>
            ))}
          </View>
        </View>
      </View>

      {children ? (
        <View style={{ paddingTop: spacing[16], borderTopWidth: 1, borderTopColor: colors.border }}>
          {children}
        </View>
      ) : null}

      {open ? <MenuPopover items={menuItems} onSelect={() => setOpen(false)} /> : null}
    </Card>
  );
}
