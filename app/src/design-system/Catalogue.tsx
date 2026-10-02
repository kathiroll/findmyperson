import { useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { BottomSheet } from './BottomSheet';
import { Button, type ButtonSize, type ButtonVariant } from './Button';
import { CaptureHealthCard } from './CaptureHealthCard';
import { Card } from './Card';
import { Field, OptionRow } from './Field';
import { HamburgerMenu } from './HamburgerMenu';
import { Icon, iconNames } from './Icon';
import { IconButton } from './IconButton';
import { IconChip } from './IconChip';
import { InfoBanner } from './InfoBanner';
import { LiveReportCard } from './LiveReportCard';
import { PulsingDot } from './PulsingDot';
import { ScreenHeader } from './ScreenHeader';
import { StepProgress } from './StepProgress';
import { Text } from './Text';
import {
  colors,
  sizes,
  spacing,
  typography,
  type ColorName,
  type TypographyVariant,
} from './theme';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: spacing[12] }}>
      <Text variant="heading" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Specimen({
  label,
  children,
  onBlue = false,
}: {
  label: string;
  children: ReactNode;
  onBlue?: boolean;
}) {
  return (
    <View style={{ gap: spacing[6] }}>
      <Text variant="caption" color="muted">
        {label}
      </Text>
      <View
        style={
          onBlue
            ? {
                backgroundColor: colors.primary,
                borderRadius: 16,
                padding: spacing[16],
                gap: spacing[8],
              }
            : { gap: spacing[8] }
        }
      >
        {children}
      </View>
    </View>
  );
}

const buttonVariants: ButtonVariant[] = ['primary', 'ghost', 'tint', 'destructive'];
const buttonSizes: ButtonSize[] = ['large', 'compact', 'small'];
const typeSpecimens = Object.keys(typography) as TypographyVariant[];
const swatches = Object.entries(colors) as [ColorName, string][];

/**
 * One screen listing every primitive in every state. Mount it from a dev entry
 * (`<DesignSystemCatalogue />`) to review the whole library on a device.
 */
export function DesignSystemCatalogue() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reason, setReason] = useState<string | null>('found');
  const [reportMenuOpen, setReportMenuOpen] = useState(true);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader variant="brand" onMenuPress={() => setMenuOpen(true)} />
      <ScrollView
        contentContainerStyle={{
          padding: sizes.gutter,
          gap: spacing[32],
          paddingBottom: spacing[40],
        }}
      >
        <Text variant="title">Design system</Text>

        <Section title="Colour">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[8] }}>
            {swatches.map(([name, value]) => (
              <View key={name} style={{ width: 104, gap: spacing[4] }}>
                <View
                  style={{
                    height: 40,
                    borderRadius: 10,
                    backgroundColor: value,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                />
                <Text variant="caption">{name}</Text>
              </View>
            ))}
          </View>
        </Section>

        <Section title="Type">
          {typeSpecimens.map((variant) => (
            <Text key={variant} variant={variant}>
              {variant}: Thank you for downloading
            </Text>
          ))}
        </Section>

        <Section title="Icons">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[16] }}>
            {iconNames.map((name) => (
              <View key={name} style={{ alignItems: 'center', gap: spacing[4], width: 72 }}>
                <Icon name={name} />
                <Text variant="caption">{name}</Text>
              </View>
            ))}
          </View>
        </Section>

        <Section title="Button">
          {buttonSizes.map((size) => (
            <Specimen key={size} label={`size ${size}`}>
              {buttonVariants.map((variant) => (
                <Button key={variant} label={`${variant} ${size}`} variant={variant} size={size} />
              ))}
            </Specimen>
          ))}
          <Specimen label="with icons / disabled / hugging">
            <Button label="Continue" trailingIcon="arrow" />
            <Button label="Call directly" variant="tint" size="compact" icon="phone" />
            <Button label="Disabled" disabled />
            <Button label="Hug content" fullWidth={false} size="small" variant="tint" />
          </Specimen>
          <Specimen label="on blue" onBlue>
            <Button label="How it works" variant="onBlue" trailingIcon="arrow" />
          </Specimen>
          <Specimen label="icon buttons">
            <View style={{ flexDirection: 'row', gap: spacing[8] }}>
              <IconButton icon="menu" accessibilityLabel="Menu" />
              <IconButton icon="back" accessibilityLabel="Back" />
              <IconButton icon="close" accessibilityLabel="Close" />
              <IconButton icon="dots" size={44} iconSize={22} accessibilityLabel="Options" />
            </View>
          </Specimen>
        </Section>

        <Section title="Card">
          <Card>
            <Text variant="itemTitle">surface</Text>
          </Card>
          <Card variant="outlined">
            <Text variant="itemTitle">outlined</Text>
          </Card>
          <Card variant="attention">
            <Text variant="itemTitle">attention</Text>
          </Card>
        </Section>

        <Section title="Field">
          <Field label="Their name" placeholder="Full name" />
          <Field
            label="Your phone number"
            required
            keyboardType="phone-pad"
            placeholder="+1 (555) 000-0000"
          />
          <Field
            label="Details"
            rows={4}
            hint="What they were wearing."
            placeholder="Anything that helps."
          />
          <Field label="Date" error="Enter a date like Sep 18, 2026" defaultValue="Sept" />
          <Specimen label="option rows">
            {['found', 'mistake', 'other'].map((id) => (
              <OptionRow
                key={id}
                label={id}
                selected={reason === id}
                onSelect={() => setReason(id)}
              />
            ))}
          </Specimen>
        </Section>

        <Section title="Info banner">
          <InfoBanner message="Please don't swipe the app closed. That stops it until your phone starts it again." />
        </Section>

        <Section title="Icon chip">
          <View style={{ flexDirection: 'row', gap: spacing[12] }}>
            <IconChip icon="person" size={48} />
            <IconChip icon="person" />
            <IconChip icon="person" size={72} />
          </View>
        </Section>

        <Section title="Screen header">
          <ScreenHeader variant="brand" onMenuPress={() => undefined} />
          <ScreenHeader
            variant="back"
            title="Report a missing person"
            trailing="Step 2 of 2"
            onBackPress={() => undefined}
          />
          <ScreenHeader variant="close" title="Possible match" onClosePress={() => undefined} />
        </Section>

        <Section title="Step progress">
          <StepProgress step={1} total={2} />
          <StepProgress step={2} total={2} />
        </Section>

        <Section title="Pulsing dot">
          <View style={{ flexDirection: 'row', gap: spacing[24], padding: spacing[12] }}>
            <PulsingDot />
            <PulsingDot pulse={false} />
            <PulsingDot color="primary" size={12} />
          </View>
        </Section>

        <Section title="Capture-health card">
          <CaptureHealthCard state="healthy" detail="On this phone only. Last saved 6 min ago." />
          <CaptureHealthCard
            state="healthy"
            pulse={false}
            detail="On this phone only. Last saved 6 min ago."
          />
          <CaptureHealthCard
            state="broken"
            title="Background location is off"
            body="Location is set to “Allow only while using the app”, so nothing is saved once your screen is off."
            action={{ label: 'Open location permission', onPress: () => undefined }}
            path="Apps › findmyperson › Permissions › Location"
          />
        </Section>

        <Section title="Live-report card">
          <LiveReportCard
            name="Alex Rivera"
            details={['Last seen Sep 18, 6:30 PM', '5th & Wren St.']}
            menuItems={[
              { label: 'Deactivate report', destructive: true, onPress: () => setSheetOpen(true) },
            ]}
            menuOpen={reportMenuOpen}
            onMenuOpenChange={setReportMenuOpen}
          >
            <Text variant="itemTitle">No replies yet</Text>
          </LiveReportCard>
          <View style={{ height: 72 }} />
        </Section>

        <Section title="Overlays">
          <Button label="Open menu" variant="tint" onPress={() => setMenuOpen(true)} />
          <Button label="Open sheet" variant="tint" onPress={() => setSheetOpen(true)} />
        </Section>
      </ScrollView>

      <HamburgerMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={[
          { label: 'Report a missing person', onPress: () => setMenuOpen(false) },
          { label: 'Report a bug', onPress: () => setMenuOpen(false) },
          { label: 'About', onPress: () => setMenuOpen(false) },
        ]}
        footnote="Free, open source and non-commercial."
      />
      <BottomSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Why are you deactivating this report?"
        description="This stops the broadcast and can't be undone."
      >
        <Button
          label="Deactivate report"
          variant="destructive"
          onPress={() => setSheetOpen(false)}
        />
        <Button
          label="Keep it active"
          variant="ghost"
          size="compact"
          onPress={() => setSheetOpen(false)}
        />
      </BottomSheet>
    </View>
  );
}
