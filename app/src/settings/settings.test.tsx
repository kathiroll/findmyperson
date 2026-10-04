import { CAPTURE_DEFAULTS } from '@findmyperson/native-location-capture';
import {
  createFakeLocationCapture,
  type FakeLocationCapture,
} from '@findmyperson/native-location-capture/fake';
import { RETENTION_DAYS } from '@findmyperson/shared';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, test, vi } from 'vitest';
import { Linking } from 'react-native';
import { CaptureProvider } from '../permissions';
import { DataStoreProvider, type DataStore } from '../store';
import { ENABLE_LABEL, OnboardingScreen, PRIVACY_CARDS, SKIP_LABEL } from '../onboarding';
import { ABUSE_CONTACT_URL, POLICIES_URL } from './links';
import { SettingsScreen } from './SettingsScreen';

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

const find = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];

const press = async (renderer: ReactTestRenderer, label: string) => {
  const target = find(renderer, label);
  if (!target) throw new Error(`nothing pressable labelled "${label}"`);
  await act(async () => {
    (target.props.onPress as () => void)();
  });
};

async function mountSettings(capture: FakeLocationCapture, store: Pick<DataStore, 'deleteAll'>) {
  const dataStore: DataStore = {
    ...store,
    runMaintenance: async () => ({ ran: true }),
    runFetchCycle: () => Promise.reject(new Error('the settings screen never fetches')),
    deviceIdentity: {
      getDeviceId: () => Promise.reject(new Error('not used')),
      authHeaders: () => Promise.reject(new Error('not used')),
      reset: () => Promise.reject(new Error('not used')),
    },
    enqueueReport: () => Promise.reject(new Error('this screen never submits')),
    runReportQueue: () => Promise.reject(new Error('this screen never submits')),
  };
  const handlers = { onOpenCaptureHealth: vi.fn(), onOpenPermissionFlow: vi.fn() };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <CaptureProvider capture={capture}>
        <DataStoreProvider dataStore={dataStore}>
          <SettingsScreen {...handlers} />
        </DataStoreProvider>
      </CaptureProvider>,
    );
  });
  return { renderer, ...handlers };
}

const config = { ...CAPTURE_DEFAULTS, notificationTitle: 't', notificationBody: 'b' };

describe('Settings', () => {
  test('pause stops the active capture module and resume starts it again', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    await capture.start(config);
    const { renderer } = await mountSettings(capture, { deleteAll: vi.fn() });
    expect(text(renderer.root)).toContain('Tracking is on');

    await press(renderer, 'Pause tracking');
    expect((await capture.getStatus()).running).toBe(false);
    expect(text(renderer.root)).toContain('Tracking is paused');

    await press(renderer, 'Resume tracking');
    expect((await capture.getStatus()).running).toBe(true);
    expect(text(renderer.root)).toContain('Tracking is on');
  });

  test('without location access the tracking card leads into the permission flow', async () => {
    const capture = createFakeLocationCapture({ permission: 'undetermined' });
    const { renderer, onOpenPermissionFlow } = await mountSettings(capture, {
      deleteAll: vi.fn(),
    });
    expect(find(renderer, 'Resume tracking')).toBeUndefined();
    await press(renderer, ENABLE_LABEL);
    expect(onOpenPermissionFlow).toHaveBeenCalledOnce();
  });

  test('delete all asks first, then stops capture before deleting, and leaves tracking off', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    await capture.start(config);
    const order: string[] = [];
    const stop = capture.stop.bind(capture);
    capture.stop = async () => {
      order.push('stop');
      await stop();
    };
    const deleteAll = vi.fn(async () => {
      order.push(`delete (running=${(await capture.getStatus()).running})`);
      return { emptyStoreConfirmed: true as const };
    });
    const { renderer } = await mountSettings(capture, { deleteAll });

    await press(renderer, 'Delete all my data');
    expect(deleteAll).not.toHaveBeenCalled();
    await press(renderer, 'Cancel');
    expect(deleteAll).not.toHaveBeenCalled();

    await press(renderer, 'Delete all my data');
    await press(renderer, 'Yes, delete all my data');
    expect(order).toEqual(['stop', 'delete (running=false)']);
    expect((await capture.getStatus()).running).toBe(false);
    expect(text(renderer.root)).toContain('All your data was deleted');
  });

  test('a failed delete is reported, not hidden', async () => {
    const capture = createFakeLocationCapture({ permission: 'always' });
    const deleteAll = vi.fn(async () => {
      throw new Error('DELETE_INCOMPLETE');
    });
    const { renderer } = await mountSettings(capture, { deleteAll });
    await press(renderer, 'Delete all my data');
    await press(renderer, 'Yes, delete all my data');
    expect(text(renderer.root)).toContain('DELETE_INCOMPLETE');
    expect(text(renderer.root)).not.toContain('All your data was deleted');
  });

  test('retention explainer states the shared retention period', async () => {
    const { renderer } = await mountSettings(createFakeLocationCapture(), { deleteAll: vi.fn() });
    expect(text(renderer.root)).toContain(`kept for ${RETENTION_DAYS} days`);
  });

  test('policies and abuse links open their URLs; capture health is a seam', async () => {
    const open = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    (Linking as unknown as { openURL: typeof open }).openURL = open;
    const { renderer, onOpenCaptureHealth } = await mountSettings(createFakeLocationCapture(), {
      deleteAll: vi.fn(),
    });
    await press(renderer, 'Policies');
    await press(renderer, 'Report abuse');
    expect(open.mock.calls.map((c) => c[0])).toEqual([POLICIES_URL, ABUSE_CONTACT_URL]);
    await press(renderer, 'Capture health');
    expect(onOpenCaptureHealth).toHaveBeenCalledOnce();
  });
});

describe('Onboarding', () => {
  async function mountOnboarding(permission: 'undetermined' | 'always') {
    const capture = createFakeLocationCapture({ permission });
    const props = { onEnable: vi.fn(), onDone: vi.fn() };
    let focus: () => void = () => undefined;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <CaptureProvider capture={capture}>
          <OnboardingScreen
            {...props}
            subscribeFocus={(cb) => {
              focus = cb;
              return () => undefined;
            }}
          />
        </CaptureProvider>,
      );
    });
    return { renderer, focus: () => act(async () => focus()), ...props };
  }

  test('shows three privacy cards and the exact CTA and reassurance copy', async () => {
    const { renderer, onEnable } = await mountOnboarding('undetermined');
    expect(PRIVACY_CARDS).toHaveLength(3);
    expect(
      renderer.root.findAll(
        (n) => n.props.testID === 'privacy-card' && (n.type as unknown) === 'View',
      ),
    ).toHaveLength(3);
    expect(text(renderer.root)).toContain('You can turn this off anytime in Settings.');
    expect(text(renderer.root)).toContain(`${RETENTION_DAYS} days`);
    await press(renderer, 'Enable location access');
    expect(onEnable).toHaveBeenCalledOnce();
  });

  test('continues into the app only once location has been allowed', async () => {
    const waiting = await mountOnboarding('undetermined');
    await waiting.focus();
    expect(waiting.onDone).not.toHaveBeenCalled();
    await press(waiting.renderer, SKIP_LABEL);
    expect(waiting.onDone).toHaveBeenCalledOnce();

    const granted = await mountOnboarding('always');
    await granted.focus();
    expect(granted.onDone).toHaveBeenCalledOnce();
  });
});
