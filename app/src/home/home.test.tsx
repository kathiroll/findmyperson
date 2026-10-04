import type { OwnReport } from '@findmyperson/shared';
import { createFakeLocationCapture } from '@findmyperson/native-location-capture/fake';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, test, vi } from 'vitest';
import { CaptureProvider } from '../permissions';
import { DataStoreProvider, type DataStore } from '../store';
import { HomeScreen } from './HomeScreen';

vi.mock(
  'react-native-safe-area-context',
  async () => await import('../navigation/__tests__/stubs'),
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = (node: ReactTestInstance): string =>
  node
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => n.children.join(''))
    .join(' ');

const row = (review: 'pending' | 'released'): OwnReport =>
  ({
    id: 1,
    query_id: '01J9Z000000000000000000000',
    state: 'active',
    request: {
      person: { name: 'Alex Rivera', description: '' },
      window: { from: 1, to: 1_790_000_000 },
    },
    report: {
      review_state: review,
      person: { name: 'Alex Rivera', description: '' },
      window: { from: 1, to: 1_790_000_000 },
    },
  }) as unknown as OwnReport;

async function mount(active: OwnReport | null) {
  const handlers = {
    menuItems: [{ label: 'Settings', onPress: vi.fn() }],
    onOpenPermissionFlow: vi.fn(),
    onOpenCaptureHealth: vi.fn(),
    onOpenLiveReport: vi.fn(),
  };
  const dataStore = { getActiveReport: async () => active } as unknown as DataStore;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <CaptureProvider capture={createFakeLocationCapture()}>
        <DataStoreProvider dataStore={dataStore}>
          <HomeScreen {...handlers} />
        </DataStoreProvider>
      </CaptureProvider>,
    );
  });
  return { renderer, ...handlers };
}

const press = async (root: ReactTestInstance, label: string) => {
  const target = root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
  if (!target) throw new Error(`nothing pressable labelled "${label}"`);
  await act(async () => (target.props.onPress as () => void)());
};

describe('Home', () => {
  test('empty state: thank-you copy, the swipe-away note and the curious list; no report card', async () => {
    const { renderer } = await mount(null);
    const copy = text(renderer.root);
    expect(copy).toContain('Thank you.');
    expect(copy).toContain("Please don't swipe the app closed");
    expect(copy).toContain("If you're curious");
    expect(copy).toContain('[VIDEO LINK]');
    expect(renderer.root.findAll((n) => n.props.testID === 'home-report-card')).toEqual([]);
    expect(
      renderer.root.findAll((n) => n.props.testID === 'capture-health-status').length,
    ).toBeGreaterThan(0);
  });

  test('has no report button and no tab bar: reporting starts from the menu', async () => {
    const { renderer } = await mount(null);
    expect(text(renderer.root)).not.toContain('Report a missing person');
  });

  test('populated state: the live report card shows and the thank-you text is hidden', async () => {
    const { renderer, onOpenLiveReport } = await mount(row('released'));
    expect(
      renderer.root.findAll((n) => n.props.testID === 'home-report-card').length,
    ).toBeGreaterThan(0);
    const copy = text(renderer.root);
    expect(copy).toContain('Alex Rivera');
    expect(copy).toContain('Your report');
    expect(copy).toContain('No replies yet');
    expect(copy).not.toContain('Thank you.');
    expect(copy).not.toContain("Please don't swipe the app closed");
    expect(copy).toContain("If you're curious");

    await press(renderer.root, 'Report options');
    await press(renderer.root, 'View report');
    expect(onOpenLiveReport).toHaveBeenCalledWith('01J9Z000000000000000000000');
  });

  test('a report still held for review is not called live', async () => {
    const { renderer } = await mount(row('pending'));
    const copy = text(renderer.root);
    expect(copy).toContain('Your report, under review');
    expect(copy).not.toMatch(/\blive\b/i);
  });

  test('the menu opens from the header and runs its entry', async () => {
    const { renderer, menuItems } = await mount(null);
    await press(renderer.root, 'Open menu');
    expect(text(renderer.root)).toContain('Free, open source and non-commercial.');
    await press(renderer.root, 'Settings');
    expect(menuItems[0]!.onPress).toHaveBeenCalledTimes(1);
  });
});
