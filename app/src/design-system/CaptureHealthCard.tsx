import { View } from 'react-native';
import { Button } from './Button';
import { Card } from './Card';
import { Icon } from './Icon';
import { Rise } from './motion';
import { PulsingDot } from './PulsingDot';
import { Text } from './Text';
import { spacing } from './theme';

/** Failure names a `broken` card can report; screens map each to its title/body/action. They come from HealthFlag in the architecture plan (section 5.5), nowhere else. */
export type CaptureHealthFlag =
  | 'background_permission_missing'
  | 'precise_location_off'
  | 'location_services_off'
  | 'background_refresh_off'
  | 'low_power_mode'
  | 'battery_optimisation_active'
  | 'hibernation_not_exempt'
  | 'oem_restriction_suspected'
  | 'service_not_running';

export type CaptureHealthCardProps =
  | {
      state: 'healthy';
      /** "Working normally" by default. */
      title?: string;
      /** "On this phone only. Last saved 6 min ago." */
      detail: string;
      /** Draw the solid dot with no pulse (the card sits under a live report). */
      pulse?: boolean;
      testID?: string;
    }
  | {
      state: 'broken';
      /** "Background location is off" */
      title: string;
      body: string;
      /** The single button to the fixing setting, e.g. "Open location permission". */
      action: { label: string; onPress: () => void };
      /** Where the setting lives: "Apps › findmyperson › Permissions › Location". */
      path?: string;
      testID?: string;
    };

/**
 * Capture-health status. Quiet pill while capture is healthy; an amber "Needs attention" card
 * naming the problem, with one button to the fixing setting, otherwise. Re-keyed on `state` so a
 * change fades up rather than snapping.
 */
export function CaptureHealthCard(props: CaptureHealthCardProps) {
  if (props.state === 'healthy') {
    const title = props.title ?? 'Working normally';
    return (
      <Rise key="healthy">
        <Card
          variant="outlined"
          testID={props.testID}
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`Location history status. ${title}. ${props.detail}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[16] }}
        >
          <PulsingDot pulse={props.pulse ?? true} />
          <View style={{ flex: 1, gap: spacing[2] }}>
            <Text variant="itemTitle">{title}</Text>
            <Text variant="caption" color="muted">
              {props.detail}
            </Text>
          </View>
        </Card>
      </Rise>
    );
  }

  return (
    <Rise key="broken">
      <Card
        variant="attention"
        testID={props.testID}
        accessibilityLabel="Location history status"
        accessibilityLiveRegion="polite"
      >
        <View style={{ gap: spacing[10] }}>
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[8] }}
            accessible
            accessibilityLabel="Needs attention"
          >
            <Icon name="alert" size={20} color="warningText" />
            <Text variant="eyebrow" color="warningText">
              Needs attention
            </Text>
          </View>
          <Text variant="heading" accessibilityRole="header">
            {props.title}
          </Text>
          <Text variant="bodySmall" color="muted">
            {props.body}
          </Text>
        </View>
        <View style={{ gap: spacing[10] }}>
          <Button
            label={props.action.label}
            onPress={props.action.onPress}
            trailingIcon="arrow"
            {...(props.testID ? { testID: `${props.testID}-action` } : {})}
          />
          {props.path ? (
            <Text variant="caption" color="muted" align="center">
              {props.path}
            </Text>
          ) : null}
        </View>
      </Card>
    </Rise>
  );
}
