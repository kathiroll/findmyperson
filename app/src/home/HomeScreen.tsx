import type { OwnReport } from '@findmyperson/shared';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CaptureHealthStatus, useCaptureHealth } from '../capture-health';
import {
  HamburgerMenu,
  Icon,
  InfoBanner,
  LiveReportCard,
  Rise,
  ScreenHeader,
  Text,
  colors,
  radii,
  sizes,
  spacing,
  type HamburgerMenuItem,
} from '../design-system';
import { useDataStore } from '../store';

export type HomeScreenProps = {
  /** Menu entries, in order. The menu is the only way to the other destinations. */
  menuItems: HamburgerMenuItem[];
  onOpenPermissionFlow: () => void;
  onOpenCaptureHealth: () => void;
  onOpenLiveReport: (reportId: string) => void;
};

/** Placeholder wording exactly as drawn in the mockups; wording changes are a later pass. */
const CURIOUS_LINKS = [
  { title: 'How findmyperson works', subtitle: '[VIDEO LINK]' },
  { heading: 'Other cool projects' },
  { title: '[PROJECT 1]', subtitle: '[one line on what it does]' },
  { title: '[PROJECT 2]', subtitle: '[one line on what it does]' },
] as const;

const lastSeenLine = (report: OwnReport['request']['window']) =>
  `Last seen ${new Date(report.to * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;

/** The reporter's active report from the local store; null when there is none or it cannot be read. */
function useActiveReport(): OwnReport | null {
  const dataStore = useDataStore();
  const [report, setReport] = useState<OwnReport | null>(null);
  useEffect(() => {
    let alive = true;
    dataStore
      .getActiveReport()
      .then((row) => alive && setReport(row))
      .catch(() => alive && setReport(null));
    return () => {
      alive = false;
    };
  }, [dataStore]);
  return report;
}

function ReportCard({ row, onOpen }: { row: OwnReport; onOpen: (reportId: string) => void }) {
  const person = (row.report ?? row.request).person;
  const window = (row.report ?? row.request).window;
  // review_state is optional only for servers that predate the gate; anything but `released`
  // that the server has said is "held" and must not read as live.
  const held = row.report?.review_state === 'pending';
  const open = () => row.query_id !== null && onOpen(row.query_id);
  return (
    <LiveReportCard
      testID="home-report-card"
      name={person.name}
      details={[lastSeenLine(window)]}
      statusLabel={held ? 'Your report, under review' : 'Your report'}
      live={!held}
      menuItems={[{ label: 'View report', icon: 'eye', onPress: open }]}
    >
      <View style={{ gap: spacing[6] }}>
        <Text variant="itemTitle">No replies yet</Text>
        <Text variant="bodySmall" color="muted">
          We can't tell you how many people this has reached, or who has seen it. That's
          intentional: it's what keeps everyone safe to respond. Replies will appear here.
        </Text>
      </View>
    </LiveReportCard>
  );
}

function CuriousList() {
  return (
    <View style={{ gap: spacing[10] }}>
      <Text variant="eyebrow" color="muted" accessibilityRole="header">
        If you're curious
      </Text>
      <View
        style={{
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radii.listCard,
          overflow: 'hidden',
        }}
      >
        {CURIOUS_LINKS.map((entry, index) =>
          'heading' in entry ? (
            <View key={entry.heading} style={{ borderTopWidth: 1, borderTopColor: colors.border }}>
              <Text
                variant="eyebrow"
                color="muted"
                style={{ paddingTop: spacing[12], paddingHorizontal: spacing[18] }}
              >
                {entry.heading}
              </Text>
            </View>
          ) : (
            <Pressable
              key={entry.title}
              accessibilityRole="link"
              accessibilityLabel={`${entry.title}, ${entry.subtitle}`}
              style={({ pressed }) => ({
                minHeight: sizes.listRow,
                paddingLeft: spacing[18],
                paddingRight: spacing[16],
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: spacing[12],
                borderTopWidth: index > 2 ? 1 : 0,
                borderTopColor: colors.border,
                backgroundColor: pressed ? colors.tint : 'transparent',
              })}
            >
              <View style={{ flexShrink: 1 }}>
                <Text variant="itemTitle">{entry.title}</Text>
                <Text variant="caption" color="muted">
                  {entry.subtitle}
                </Text>
              </View>
              <Icon name="external" size={20} color="primaryPressed" />
            </Pressable>
          ),
        )}
      </View>
    </View>
  );
}

/**
 * Home, as on the v2 artboards: brand header with the hamburger, the honest capture-health row,
 * then either "Thank you…" (nothing to do) or, once the reporter has an active report, that
 * report's card. No tab bar and no report button here: reporting starts from the menu.
 */
export function HomeScreen({
  menuItems,
  onOpenPermissionFlow,
  onOpenCaptureHealth,
  onOpenLiveReport,
}: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  const [menuOpen, setMenuOpen] = useState(false);
  const { status } = useCaptureHealth();
  const report = useActiveReport();
  const needsFixing = status !== null && status.health.length > 0;

  const items = menuItems.map((item) => ({
    ...item,
    onPress: () => {
      setMenuOpen(false);
      item.onPress();
    },
  }));
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <View
      testID="screen-Home"
      style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}
    >
      <ScreenHeader variant="brand" onMenuPress={() => setMenuOpen(true)} />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: sizes.gutter,
          paddingTop: spacing[8],
          paddingBottom: spacing[24] + insets.bottom,
          gap: report ? spacing[16] : spacing[28],
        }}
      >
        {report ? <ReportCard row={report} onOpen={onOpenLiveReport} /> : null}
        <CaptureHealthStatus
          onOpenPermissionFlow={onOpenPermissionFlow}
          onOpenDiagnostics={onOpenCaptureHealth}
        />
        {report ? null : (
          <Rise delay={80} style={{ gap: spacing[12] }}>
            <Text variant="title" accessibilityRole="header" testID="home-thank-you">
              {needsFixing
                ? 'Thank you. One thing needs fixing first.'
                : "Thank you. There's nothing more to do."}
            </Text>
            <Text variant="body" color="muted">
              {needsFixing ? 'After that, leave' : 'Leave'} findmyperson installed and put your
              phone away. If a report ever lines up with places you've been, your own phone works
              that out and tells only you. Nobody else is told, not even us, unless you choose to
              reply.
            </Text>
            <InfoBanner message="Please don't swipe the app closed. That stops it until your phone starts it again, which can take hours." />
          </Rise>
        )}
        <CuriousList />
      </ScrollView>
      <HamburgerMenu
        visible={menuOpen}
        onClose={closeMenu}
        items={items}
        footnote="Free, open source and non-commercial."
      />
    </View>
  );
}
