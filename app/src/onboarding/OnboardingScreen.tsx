import { RETENTION_DAYS } from '@findmyperson/shared';
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  IconChip,
  ScreenHeader,
  Text,
  colors,
  sizes,
  spacing,
  type IconName,
} from '../design-system';
import { useCapture } from '../permissions';

export type OnboardingScreenProps = {
  /** "Enable location access": opens the permission flow. */
  onEnable: () => void;
  /** Leaves onboarding for the app. Called after the flow if location is already allowed. */
  onDone: () => void;
  /** Sent when the permission flow closes; lets onboarding move on once access is granted. */
  subscribeFocus?: (onFocus: () => void) => () => void;
};

type PrivacyCard = { icon: IconName; title: string; body: string };

// Every claim below is backed by something merged: the store is SQLCipher-encrypted and kept out
// of cloud and device backups (packages/encrypted-store, plan 4.5), retention is RETENTION_DAYS
// in the shared contracts, and Settings has the pause and delete controls.
export const PRIVACY_CARDS: readonly PrivacyCard[] = [
  {
    icon: 'phone',
    title: 'Your location stays on your phone',
    body: 'Where you have been is saved in an encrypted store on this phone only. It is left out of your phone’s cloud and device backups.',
  },
  {
    icon: 'eye',
    title: `Kept for ${RETENTION_DAYS} days, then deleted`,
    body: `Your history is never kept longer than ${RETENTION_DAYS} days. You can delete all of it at any time in Settings.`,
  },
  {
    icon: 'person',
    title: 'You are in control',
    body: 'Pause tracking from Settings whenever you like, and start it again when you want.',
  },
];

export const ENABLE_LABEL = 'Enable location access';
export const SKIP_LABEL = 'Not now';

export function OnboardingScreen({ onEnable, onDone, subscribeFocus }: OnboardingScreenProps) {
  const insets = useSafeAreaInsets();
  const capture = useCapture();

  // Back from the permission flow: carry on into the app once location has been allowed.
  useEffect(() => {
    if (!subscribeFocus) return undefined;
    return subscribeFocus(() => {
      void capture.getStatus().then((status) => {
        if (status.permission === 'foreground_only' || status.permission === 'always') onDone();
      });
    });
  }, [capture, onDone, subscribeFocus]);

  return (
    <View
      testID="screen-Onboarding"
      style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}
    >
      <ScreenHeader variant="brand" />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: sizes.gutter,
          paddingTop: spacing[16],
          paddingBottom: spacing[16],
          gap: spacing[20],
        }}
      >
        <View style={{ gap: spacing[12] }}>
          <Text variant="title" accessibilityRole="header">
            Your location never leaves your phone
          </Text>
          <Text variant="body" color="muted">
            findmyperson helps people who may have crossed paths with a missing person help find
            them. Here is what that means for your privacy.
          </Text>
        </View>
        {PRIVACY_CARDS.map((card) => (
          <Card key={card.title} testID="privacy-card">
            <IconChip icon={card.icon} size={48} iconColor="primary" />
            <Text variant="itemTitle">{card.title}</Text>
            <Text variant="bodySmall" color="muted">
              {card.body}
            </Text>
          </Card>
        ))}
      </ScrollView>
      <View
        style={{
          paddingHorizontal: sizes.gutter,
          paddingTop: spacing[12],
          paddingBottom: spacing[16] + insets.bottom,
          gap: spacing[12],
        }}
      >
        <Button
          label={ENABLE_LABEL}
          fullWidth
          trailingIcon="arrow"
          accessibilityLabel={ENABLE_LABEL}
          onPress={onEnable}
        />
        <Text variant="caption" color="muted" align="center">
          You can turn this off anytime in Settings.
        </Text>
        <Button label={SKIP_LABEL} variant="ghost" fullWidth onPress={onDone} />
      </View>
    </View>
  );
}
