import type { CapturePlatform } from '@findmyperson/native-location-capture';
import { useState, type ReactNode } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  IconChip,
  InfoBanner,
  ScreenHeader,
  Text,
  colors,
  sizes,
  spacing,
} from '../design-system';
import type { PermissionFlow } from './usePermissionFlow';
import { usePermissionFlow } from './usePermissionFlow';

export type PermissionFlowScreenProps = {
  /** Leaves the flow: back to wherever it was opened from. */
  onClose: () => void;
  /** Defaults to the device's platform. */
  platform?: CapturePlatform;
};

const devicePlatform = (): CapturePlatform => (Platform.OS === 'ios' ? 'ios' : 'android');

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: spacing[12] }}>
      <Text variant="title" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Body({ children }: { children: ReactNode }) {
  return <Text variant="body">{children}</Text>;
}

/**
 * Google Play's prominent disclosure. Play requires it to say that the app collects location,
 * that this includes the background, and to appear before the runtime prompt; the wording and
 * the order are pinned by a test.
 */
function Disclosure({ flow, onDecline }: { flow: PermissionFlow; onDecline: () => void }) {
  return (
    <Section title="Location use in the background">
      <IconChip icon="phone" />
      <Body>
        findmyperson collects your phone's location, including in the background when the app is
        closed or not in use, so that a missing person's report can be matched against where phones
        were. Location is stored encrypted on this phone and is shared only if you choose to share
        it with a family.
      </Body>
      <Body>
        Next, Android will ask for location access. Choose "While using the app" first; you can
        allow "all the time" on the following screen.
      </Body>
      <Button
        label="Continue"
        trailingIcon="arrow"
        disabled={flow.busy}
        onPress={() => void flow.request('foreground')}
      />
      <Button label="Not now" variant="ghost" onPress={onDecline} />
    </Section>
  );
}

function Purpose({ flow, onDecline }: { flow: PermissionFlow; onDecline: () => void }) {
  return (
    <Section title="Why findmyperson needs your location">
      <IconChip icon="phone" />
      <Body>
        findmyperson keeps a private, encrypted record of where this phone has been so that, if
        someone nearby goes missing, a possible match can be found. We ask for location while you
        use the app first.
      </Body>
      <Button
        label="Continue"
        trailingIcon="arrow"
        disabled={flow.busy}
        onPress={() => void flow.request('foreground')}
      />
      <Button label="Not now" variant="ghost" onPress={onDecline} />
    </Section>
  );
}

/**
 * iOS lets an app ask for "Always" once, and it cannot ask whether it already did. From then on
 * the person has to change it in Settings, and Open Settings lands on the Settings list (this app
 * has no page of its own there), so the steps start at the top and name what they will see.
 */
function SettingsGuide({ flow, choice }: { flow: PermissionFlow; choice: string }) {
  return (
    <View style={{ gap: spacing[12] }} testID="settings-guide">
      <Text variant="body" accessibilityRole="header">
        Turn on Always in Settings
      </Text>
      <Body>iOS lets an app ask only once, and that question has been answered.</Body>
      <Body>1. Tap Open Settings below.</Body>
      <Body>2. Tap Privacy & Security. (On iOS 15 it is called Privacy.)</Body>
      <Body>3. Tap Location Services.</Body>
      <Body>4. Scroll to findmyperson and tap it.</Body>
      <Body>{`5. Choose ${choice}. Leave Precise Location on.`}</Body>
      <Body>6. Come back to findmyperson. This screen updates by itself.</Body>
      <Text variant="bodySmall" color="muted">
        If Settings opens on a findmyperson page instead, tap Location, then choose Always.
      </Text>
      <Button label="Open Settings" onPress={() => void flow.openSettings('app')} />
      {flow.settingsUnavailable ? (
        <InfoBanner
          icon="alert"
          message="Settings could not be opened. Open the Settings app yourself and follow the steps above."
        />
      ) : null}
    </View>
  );
}

function Upgrade({ flow, platform }: { flow: PermissionFlow; platform: CapturePlatform }) {
  const android = platform === 'android';
  const guided = !android && flow.upgradePromptUsed;
  return (
    <Section title='Allow location "all the time"'>
      <Body>
        Right now findmyperson can only use location while it is open on screen. A missing-person
        search needs to know where phones were over the last hours, including when nobody has the
        app open, so without "all the time" most of that record would be missing.
      </Body>
      {guided ? (
        <SettingsGuide flow={flow} choice="Always" />
      ) : (
        <Body>
          {android
            ? 'Tap the button to open this app\'s location settings, choose "Allow all the time", then come back.'
            : 'iOS will ask once more. Choose "Change to Always Allow".'}
        </Body>
      )}
      {flow.upgradeNotGranted && android ? (
        <InfoBanner
          icon="alert"
          message={
            'Location is still "only while using the app". Choose "Allow all the time" in settings.'
          }
        />
      ) : null}
      {guided ? null : (
        <Button
          label={android ? 'Open settings' : 'Allow Always'}
          disabled={flow.busy}
          onPress={() => void flow.request('background')}
        />
      )}
      <Button label="Keep while-using only" variant="ghost" onPress={flow.declineUpgrade} />
    </Section>
  );
}

function Limited({
  flow,
  platform,
  onClose,
}: {
  flow: PermissionFlow;
  platform: CapturePlatform;
  onClose: () => void;
}) {
  return (
    <Section title="Limited capture">
      <InfoBanner
        icon="alert"
        message="Location is only recorded while the app is open, and only occasionally in the background."
      />
      <Body>
        You can still report a missing person and see matches. Your phone will contribute much less
        to other people's searches. You can change this whenever you like.
      </Body>
      {platform === 'ios' && flow.upgradePromptUsed ? (
        <SettingsGuide flow={flow} choice="Always" />
      ) : (
        <Button label="Allow all the time" onPress={flow.reconsiderUpgrade} />
      )}
      <Button label="Done" variant="ghost" onPress={onClose} />
    </Section>
  );
}

function Denied({
  flow,
  platform,
  onClose,
}: {
  flow: PermissionFlow;
  platform: CapturePlatform;
  onClose: () => void;
}) {
  return (
    <Section title="Location is turned off">
      <InfoBanner icon="alert" message="findmyperson cannot record where this phone has been." />
      <Body>
        Your phone is not contributing to any search, and you will not be matched as a bystander.
        You can still report a missing person and follow your report. To turn location on, open
        settings and allow it for findmyperson.
      </Body>
      {platform === 'ios' ? (
        <SettingsGuide flow={flow} choice="While Using the App or Always" />
      ) : (
        <>
          <Button label="Open settings" onPress={() => void flow.openSettings('app')} />
          {flow.settingsUnavailable ? (
            <InfoBanner
              icon="alert"
              message="This phone has no settings page we can open. Find findmyperson under Settings, then Apps."
            />
          ) : null}
        </>
      )}
      <Button label="Continue without location" variant="ghost" onPress={onClose} />
    </Section>
  );
}

function Restricted({ onClose }: { onClose: () => void }) {
  return (
    <Section title="Location is managed on this phone">
      <InfoBanner
        icon="info"
        message="A setting on this phone, such as parental controls or a work profile, blocks location for apps."
      />
      <Body>
        findmyperson cannot change that and will not record location. You can still report a missing
        person and follow your report. If the restriction is removed, return here to turn location
        on.
      </Body>
      <Button label="Continue without location" onPress={onClose} />
    </Section>
  );
}

function Skipped({ onReview, onClose }: { onReview: () => void; onClose: () => void }) {
  return (
    <Section title="Location not allowed yet">
      <Body>
        Without location, your phone will not contribute to any search and you will not be matched.
        Reporting a missing person still works. You can allow location later from this screen.
      </Body>
      <Button label="Review again" onPress={onReview} />
      <Button label="Continue without location" variant="ghost" onPress={onClose} />
    </Section>
  );
}

function Complete({ flow, onClose }: { flow: PermissionFlow; onClose: () => void }) {
  return (
    <Section title={flow.remedies.length === 0 ? 'All set' : 'Almost there'}>
      <Body>
        {flow.remedies.length === 0
          ? 'Location is allowed all the time. Nothing else is needed.'
          : 'Location is allowed all the time, but your phone may still limit capture:'}
      </Body>
      <Button
        label="Done"
        variant={flow.remedies.length === 0 ? 'primary' : 'ghost'}
        onPress={onClose}
      />
    </Section>
  );
}

function Remedies({ flow }: { flow: PermissionFlow }) {
  if (flow.remedies.length === 0) return null;
  return (
    <View style={{ gap: spacing[16] }} testID="permission-remedies">
      {flow.remedies.map((remedy) => (
        <Card key={remedy.flag} variant="attention" testID={`remedy-${remedy.flag}`}>
          <Text variant="body" accessibilityRole="header">
            {remedy.title}
          </Text>
          <Text variant="bodySmall" color="muted">
            {remedy.body}
          </Text>
          <Button
            label={remedy.action}
            variant="tint"
            onPress={() => void flow.openSettings(remedy.target)}
          />
          {flow.settingsUnavailable === remedy.target ? (
            <Text variant="bodySmall" color="muted">
              This phone has no page we can open for this. Look in Settings, then Apps, then
              findmyperson.
            </Text>
          ) : null}
        </Card>
      ))}
    </View>
  );
}

/**
 * The permission flow, one screen that renders the stage the OS-reported permission puts the user
 * in (`permissionStage`). Android asks for the foreground permission behind Play's prominent
 * disclosure, then explains and hands off to settings for "all the time"; iOS asks While-In-Use,
 * then upgrades to Always. Every denied, restricted and partial state has copy and a next step.
 */
export function PermissionFlowScreen({ onClose, platform }: PermissionFlowScreenProps) {
  const resolved = platform ?? devicePlatform();
  const flow = usePermissionFlow(resolved);
  const insets = useSafeAreaInsets();
  const [skipped, setSkipped] = useState(false);
  const stage = flow.stage;

  const askStage = stage === 'disclosure' || stage === 'purpose';
  const shownStage = askStage && skipped ? 'skipped' : stage;

  let body: ReactNode = null;
  if (askStage) {
    body = skipped ? (
      <Skipped onReview={() => setSkipped(false)} onClose={onClose} />
    ) : stage === 'disclosure' ? (
      <Disclosure flow={flow} onDecline={() => setSkipped(true)} />
    ) : (
      <Purpose flow={flow} onDecline={() => setSkipped(true)} />
    );
  } else if (stage === 'upgrade') {
    body = <Upgrade flow={flow} platform={resolved} />;
  } else if (stage === 'limited') {
    body = <Limited flow={flow} platform={resolved} onClose={onClose} />;
  } else if (stage === 'denied') {
    body = <Denied flow={flow} platform={resolved} onClose={onClose} />;
  } else if (stage === 'restricted') {
    body = <Restricted onClose={onClose} />;
  } else if (stage === 'complete') {
    body = <Complete flow={flow} onClose={onClose} />;
  }

  return (
    <View
      testID="screen-PermissionFlow"
      style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}
    >
      <ScreenHeader variant="back" title="Location permission" onBackPress={onClose} />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: sizes.gutter,
          paddingTop: spacing[24],
          paddingBottom: spacing[24] + insets.bottom,
          gap: spacing[20],
        }}
      >
        <View testID={stage ? `permission-stage-${shownStage}` : undefined}>{body}</View>
        {stage === 'complete' || stage === 'limited' || stage === 'upgrade' ? (
          <Remedies flow={flow} />
        ) : null}
      </ScrollView>
    </View>
  );
}
