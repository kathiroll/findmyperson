import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeLocationCapture } from '@findmyperson/native-location-capture/fake';
import { createTestVault, nodeSqlcipherDriver } from '@findmyperson/encrypted-store/testing';
import {
  API_ENDPOINTS,
  DEVICE_AUTH_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  MAX_PERSON_PHOTOS,
  MAX_PHOTO_BASE64_CHARS,
  ReportSubmitRequestSchema,
  type PersonPhoto,
  type Report,
  type ReportSubmitRequest,
} from '@findmyperson/shared';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CaptureProvider } from '../permissions';
import { createDataStore, DataStoreProvider, type DataStore } from '../store';
import { createReportApi, type ApiFetch, type ReportApi, type SubmitOutcome } from './api';
import {
  addPhoto,
  buildRequest,
  canAddPhoto,
  emptyForm,
  normalizePhone,
  PHOTO_LIMIT_ERROR,
  validateForm,
  type ReportFormValues,
} from './form';
import { fitWithin, makeThumbnail, PhotoTooLargeError, type PhotoPort } from './image';
import { ReportSubmitScreen, REVIEW_NOTICE } from './ReportSubmitScreen';
import { ReportServicesProvider } from './services';

vi.mock(
  'react-native-safe-area-context',
  async () => await import('../navigation/__tests__/stubs'),
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_791_000_000;
const DEVICE = '3f1c2a64-8d7e-4b3a-9c51-0a6f2d4e8b17';
const validValues = (over: Partial<ReportFormValues> = {}): ReportFormValues => ({
  ...emptyForm,
  name: 'Asha Verma',
  phone: '+91 98100 12345',
  date: '2026-10-03',
  time: '6:30 PM',
  description: 'Blue jacket',
  location: { lat: 28.6139, lon: 77.209 },
  ...over,
});
// Local time "now" for the form: one hour after the last-seen moment above.
const lastSeen = (values: ReportFormValues) => {
  const [y, m, d] = values.date.split('-').map(Number);
  return Math.floor(new Date(y!, m! - 1, d!, 18, 30).getTime() / 1000);
};

describe('form validation', () => {
  const now = lastSeen(validValues()) + 3600;

  test('a complete form has no errors and builds a request the server schema accepts', () => {
    expect(validateForm(validValues(), now)).toEqual({});
    const request = buildRequest(validValues(), now);
    expect(ReportSubmitRequestSchema.safeParse(request).success).toBe(true);
    expect(request.reporter_phone).toBe('+919810012345');
    expect(request.window.from).toBeLessThanOrEqual(lastSeen(validValues()));
    expect(request.window.to).toBeGreaterThanOrEqual(lastSeen(validValues()));
  });

  test('the phone cannot be empty, blank or without a country code', () => {
    for (const phone of ['', '   ', '9810012345', '+12', 'call me']) {
      expect(validateForm(validValues({ phone }), now).phone, phone).toBeTruthy();
    }
    expect(() => buildRequest(validValues({ phone: '' }), now)).toThrow();
    expect(normalizePhone(' +1 (415) 555-0123 ')).toBe('+14155550123');
  });

  test('name, location, date and time are all required', () => {
    const errors = validateForm(
      validValues({ name: ' ', location: null, date: '', time: '' }),
      now,
    );
    expect(Object.keys(errors).sort()).toEqual(['date', 'location', 'name', 'time']);
  });

  test('refuses impossible, future and too-old moments', () => {
    expect(validateForm(validValues({ date: '2026-02-31' }), now).date).toBeTruthy();
    expect(validateForm(validValues({ time: '25:00' }), now).time).toBeTruthy();
    expect(validateForm(validValues({ time: '13:00 PM' }), now).time).toBeTruthy();
    expect(validateForm(validValues(), lastSeen(validValues()) - 60).time).toMatch(/future/);
    expect(validateForm(validValues(), now + 40 * 86_400).date).toMatch(/30 days/);
  });

  test('reads 24 hour and 12 hour times alike', () => {
    expect(buildRequest(validValues({ time: '18:30' }), now).window).toEqual(
      buildRequest(validValues({ time: '6:30 pm' }), now).window,
    );
  });
});

describe('photos on the form', () => {
  const now = lastSeen(validValues()) + 3600;
  const photo = (n: number): PersonPhoto => ({
    mime: 'image/jpeg',
    w: 256,
    h: 192,
    b64: `QUJ${'ABCD'[n]}`,
  });

  test('the cap is two, and the message says so', () => {
    expect(MAX_PERSON_PHOTOS).toBe(2);
    expect(PHOTO_LIMIT_ERROR).toBe(
      'A report can have 2 photos at most. Remove one to add a different photo.',
    );
  });

  test('a form with no photo builds a request with no photos member', () => {
    expect(validateForm(validValues(), now)).toEqual({});
    const request = buildRequest(validValues(), now);
    expect('photos' in request.person).toBe(false);
    expect(ReportSubmitRequestSchema.safeParse(request).success).toBe(true);
  });

  test('one photo and two are accepted and sent in the order they were added', () => {
    for (const photos of [[photo(0)], [photo(0), photo(1)]]) {
      expect(validateForm(validValues({ photos }), now)).toEqual({});
      const request = buildRequest(validValues({ photos }), now);
      expect(request.person.photos).toEqual(photos);
      expect(ReportSubmitRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  test('a third photo is refused with the message and the two already there are kept', () => {
    const one = addPhoto([], photo(0));
    expect(one).toEqual({ ok: true, photos: [photo(0)] });
    const two = addPhoto([photo(0)], photo(1));
    expect(two).toEqual({ ok: true, photos: [photo(0), photo(1)] });
    expect(canAddPhoto([photo(0)])).toBe(true);
    expect(canAddPhoto([photo(0), photo(1)])).toBe(false);
    expect(addPhoto([photo(0), photo(1)], photo(2))).toEqual({
      ok: false,
      error: PHOTO_LIMIT_ERROR,
    });
  });

  test('a form holding three photos does not validate and builds nothing', () => {
    const photos = [photo(0), photo(1), photo(2)];
    expect(validateForm(validValues({ photos }), now)).toEqual({ photos: PHOTO_LIMIT_ERROR });
    expect(() => buildRequest(validValues({ photos }), now)).toThrow(RangeError);
  });
});

describe('photo thumbnail', () => {
  const picked = { uri: 'file://p.jpg', width: 4000, height: 3000 };

  test('fits the longest edge to 256 px and never upscales', () => {
    expect(fitWithin(4000, 3000, 256)).toEqual({ width: 256, height: 192 });
    expect(fitWithin(3000, 4000, 256)).toEqual({ width: 192, height: 256 });
    expect(fitWithin(100, 80, 256)).toEqual({ width: 100, height: 80 });
  });

  test('asks the platform for the downscaled size, not the original', async () => {
    const resize = vi.fn(async () => ({ mime: 'image/jpeg' as const, b64: 'QUJD' }));
    const photo = await makeThumbnail({ pick: async () => picked, resize }, picked);
    expect(resize).toHaveBeenCalledWith(
      picked,
      expect.objectContaining({ width: 256, height: 192 }),
    );
    expect(photo).toEqual({ mime: 'image/jpeg', w: 256, h: 192, b64: 'QUJD' });
  });

  test('lowers the quality until it fits the size cap, and gives up past that', async () => {
    const big = 'A'.repeat(MAX_PHOTO_BASE64_CHARS + 4);
    const qualities: number[] = [];
    const port: PhotoPort = {
      pick: async () => picked,
      resize: async (_p, target) => {
        qualities.push(target.quality);
        return { mime: 'image/webp', b64: qualities.length < 3 ? big : 'QUJD' };
      },
    };
    expect((await makeThumbnail(port, picked)).b64).toBe('QUJD');
    expect(qualities).toHaveLength(3);
    const never: PhotoPort = { ...port, resize: async () => ({ mime: 'image/webp', b64: big }) };
    await expect(makeThumbnail(never, picked)).rejects.toBeInstanceOf(PhotoTooLargeError);
  });
});

describe('the submit call', () => {
  const request = buildRequest(validValues(), lastSeen(validValues()) + 3600);
  const key = '0c0d4f0e-7d1a-4c55-8f7e-2b9a6a1d3e44';
  const reportBody = (): { report: Report } => ({
    report: {
      query_id: '01J9ZZZZZZZZZZZZZZZZZZZZZZ'.replace(/Z/g, '0'),
      revision: 1,
      status: 'active',
      review_state: 'pending',
      created_at: NOW,
      updated_at: NOW,
      expires_at: NOW + 86_400,
      ended_at: null,
      center: request.center,
      radius_m: request.radius_m,
      window: request.window,
      person: request.person,
      reporter_phone: request.reporter_phone,
    },
  });
  const api = (fetch: ApiFetch, baseUrl: string | null = 'https://api.test') =>
    createReportApi({ baseUrl, identity: { getDeviceId: async () => DEVICE }, fetch });
  const reply = (status: number, body: unknown) => async () => ({
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

  test('POSTs the real endpoint with the device header and the idempotency key', async () => {
    const fetch = vi.fn<ApiFetch>(reply(201, reportBody()));
    const outcome = await api(fetch).submitReport(request, key);
    expect(outcome.kind).toBe('ok');
    const [url, init] = fetch.mock.calls[0]!;
    expect(API_ENDPOINTS.submitReport).toMatchObject({ method: 'POST', path: '/v1/reports' });
    expect(url).toBe('https://api.test/v1/reports');
    expect(init.method).toBe('POST');
    expect(init.headers[DEVICE_AUTH_HEADER]).toBe(`FMP-Device ${DEVICE}`);
    expect(init.headers[IDEMPOTENCY_KEY_HEADER]).toBe(key);
    expect(JSON.parse(init.body)).toEqual(request);
  });

  test('sorts outcomes into stored, try again, and refused for good', async () => {
    const outcome = async (status: number, body: unknown): Promise<SubmitOutcome> =>
      api(vi.fn<ApiFetch>(reply(status, body))).submitReport(request, key);
    const error = (code: string) => ({ error: { code, message: code } });
    expect(await outcome(503, 'down')).toMatchObject({ kind: 'retry' });
    expect(await outcome(429, error('rate_limited'))).toMatchObject({ kind: 'retry' });
    expect(await outcome(409, error('idempotency_in_progress'))).toMatchObject({ kind: 'retry' });
    expect(await outcome(201, '<html>')).toMatchObject({ kind: 'retry', code: 'bad_response' });
    expect(await outcome(400, error('invalid_request'))).toMatchObject({
      kind: 'rejected',
      code: 'invalid_request',
    });
    const offline = api(async () => {
      throw new TypeError('Network request failed');
    });
    expect(await offline.submitReport(request, key)).toEqual({ kind: 'retry', code: 'network' });
  });

  test('with no backend configured nothing is sent and the report stays queued', async () => {
    const fetch = vi.fn<ApiFetch>();
    expect(await api(fetch, null).submitReport(request, key)).toEqual({
      kind: 'retry',
      code: 'api_not_configured',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---- queue and screen, against a real SQLCipher store ---------------------------------------

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function realDataStore(clock: { now: number }) {
  const directory = mkdtempSync(join(tmpdir(), 'fmp-report-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const vault = createTestVault(directory);
  const driver = nodeSqlcipherDriver();
  let counter = 0;
  const randomBytes = (length: number) =>
    Uint8Array.from({ length }, (_, i) => (i + ++counter) % 251);
  return createDataStore(
    () => ({ vault, driver }),
    undefined,
    () => clock.now,
    randomBytes,
  );
}

/** A backend that is down until `up`, then stores each distinct idempotency key once. */
function fakeBackend() {
  const state = {
    up: false,
    calls: [] as string[],
    requests: [] as ReportSubmitRequest[],
    stored: new Map<string, Report>(),
  };
  const api: ReportApi = {
    async submitReport(request, key) {
      state.calls.push(key);
      state.requests.push(request);
      if (!state.up) return { kind: 'retry', code: 'network' };
      if (!state.stored.has(key)) {
        state.stored.set(key, {
          query_id: '01J9Z0000000000000000000' + String(state.stored.size).padStart(2, '0'),
          revision: 1,
          status: 'active',
          review_state: 'pending',
          created_at: NOW,
          updated_at: NOW,
          expires_at: NOW + 86_400,
          ended_at: null,
          ...request,
        });
      }
      return { kind: 'ok', report: state.stored.get(key)! };
    },
  };
  return { state, api };
}

describe('the durable submit queue', () => {
  test('keeps one idempotency key across retries and files exactly one report', async () => {
    const clock = { now: NOW };
    const store = realDataStore(clock);
    const backend = fakeBackend();
    const row = await store.enqueueReport(
      buildRequest(validValues(), lastSeen(validValues()) + 3600),
    );
    expect(row.state).toBe('queued');

    let result = await store.runReportQueue(backend.api);
    expect(result.retrying).toEqual([{ id: row.id, code: 'network' }]);
    // Backing off: a pass right away does not hammer the server.
    await store.runReportQueue(backend.api);
    expect(backend.state.calls).toHaveLength(1);

    backend.state.up = true;
    clock.now += 3600;
    result = await store.runReportQueue(backend.api);
    expect(result.acknowledged).toHaveLength(1);
    expect(new Set(backend.state.calls).size).toBe(1);
    expect(backend.state.stored.size).toBe(1);

    // An acknowledged row is not sent again.
    expect((await store.runReportQueue(backend.api)).acknowledged).toEqual([]);
    expect(backend.state.calls).toHaveLength(2);
  });

  test('a refusal is final and the row says so', async () => {
    const clock = { now: NOW };
    const store = realDataStore(clock);
    const row = await store.enqueueReport(
      buildRequest(validValues(), lastSeen(validValues()) + 3600),
    );
    const api: ReportApi = {
      submitReport: async () => ({ kind: 'rejected', code: 'invalid_request', message: 'bad' }),
    };
    const result = await store.runReportQueue(api);
    expect(result.failed).toEqual([{ id: row.id, code: 'invalid_request', message: 'bad' }]);
    expect((await store.runReportQueue(api)).failed).toEqual([]);
  });

  test('the device id is made once and kept', async () => {
    const store = realDataStore({ now: NOW });
    const first = await store.deviceIdentity.getDeviceId();
    expect(await store.deviceIdentity.getDeviceId()).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
  });
});

const text = (node: ReactTestInstance): string =>
  node
    .findAll((n) => (n.type as unknown) === 'Text')
    .map((n) => n.children.join(''))
    .join(' ');
const input = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function',
  )[0]!;
const type = async (renderer: ReactTestRenderer, label: string, value: string) =>
  act(async () => {
    (input(renderer, label).props.onChangeText as (v: string) => void)(value);
  });
const pressBroadcast = (renderer: ReactTestRenderer) =>
  act(async () => {
    const button = renderer.root.findAll(
      (n) =>
        n.props.accessibilityLabel === 'Broadcast report' && typeof n.props.onPress === 'function',
    )[0]!;
    (button.props.onPress as () => void)();
  });
// The press handler is fire-and-forget, so wait for the store (real SQLCipher) to finish.
const settle = (until: () => boolean = () => false) =>
  act(async () => {
    for (let i = 0; i < 200 && !until(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

describe('the report screen', () => {
  async function mount(
    dataStore: DataStore,
    api: ReportApi,
    now: () => number,
    photo: PhotoPort | null = null,
  ) {
    const onSubmitted = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <CaptureProvider capture={createFakeLocationCapture()}>
          <DataStoreProvider dataStore={dataStore}>
            <ReportServicesProvider services={{ photo, location: null, api }}>
              <ReportSubmitScreen
                onBack={vi.fn()}
                onSubmitted={onSubmitted}
                retryIntervalMs={5}
                now={now}
              />
            </ReportServicesProvider>
          </DataStoreProvider>
        </CaptureProvider>,
      );
    });
    cleanups.push(() => act(async () => renderer.unmount()));
    return { renderer, onSubmitted };
  }
  const fill = async (
    renderer: ReactTestRenderer,
    over: { phone?: string; coords?: string } = {},
  ) => {
    await type(renderer, 'Their name, required', 'Asha Verma');
    await type(renderer, 'Your phone number, required', over.phone ?? '+919810012345');
    await type(renderer, 'Last known location, required', over.coords ?? '28.6139, 77.2090');
    await type(renderer, 'Date, required', '2026-10-03');
    await type(renderer, 'Time, required', '6:30 PM');
  };
  const clockNow = () => lastSeen(validValues()) + 3600;

  test('an empty phone blocks submission and nothing is queued or sent', async () => {
    const backend = fakeBackend();
    backend.state.up = true;
    const store = realDataStore({ now: clockNow() });
    const { renderer, onSubmitted } = await mount(store, backend.api, clockNow);
    await fill(renderer, { phone: '' });
    await pressBroadcast(renderer);
    await settle();
    expect(text(renderer.root)).toContain('Your phone number is required');
    expect(backend.state.calls).toHaveLength(0);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect((await store.runReportQueue(backend.api)).acknowledged).toEqual([]);
  });

  test('pasted coordinates are shown back as the point that will be sent', async () => {
    const { renderer } = await mount(
      realDataStore({ now: clockNow() }),
      fakeBackend().api,
      clockNow,
    );
    await type(renderer, 'Last known location, required', '28.6139°, 77.2090°');
    expect(text(renderer.root)).toContain('Will be sent as 28.61390, 77.20900');
  });

  test('unreadable coordinates block submission with the error shown and nothing sent', async () => {
    const backend = fakeBackend();
    backend.state.up = true;
    const store = realDataStore({ now: clockNow() });
    const { renderer, onSubmitted } = await mount(store, backend.api, clockNow);
    await fill(renderer, { coords: '95, 77.2' });
    await pressBroadcast(renderer);
    await settle();
    expect(text(renderer.root)).toContain('Latitude must be between -90 and 90.');
    expect(backend.state.calls).toHaveLength(0);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect((await store.runReportQueue(backend.api)).acknowledged).toEqual([]);
  });

  test('says plainly that the report is under review, and never "live"', async () => {
    const { renderer } = await mount(
      realDataStore({ now: clockNow() }),
      fakeBackend().api,
      clockNow,
    );
    const copy = text(renderer.root);
    expect(copy).toContain(REVIEW_NOTICE);
    expect(copy).toContain('reviewed before anyone is notified');
    expect(copy.toLowerCase()).not.toContain('is live');
  });

  test('a valid form is submitted once to the backend and the screen reports the report id', async () => {
    const backend = fakeBackend();
    backend.state.up = true;
    const { renderer, onSubmitted } = await mount(
      realDataStore({ now: clockNow() }),
      backend.api,
      clockNow,
    );
    await fill(renderer);
    await pressBroadcast(renderer);
    await settle(() => backend.state.calls.length === 1 && onSubmitted.mock.calls.length === 1);
    expect(backend.state.calls).toHaveLength(1);
    expect(onSubmitted).toHaveBeenCalledWith(
      Array.from(backend.state.stored.values())[0]!.query_id,
    );
  });

  test('offline: says it is saved but not sent, keeps retrying, and finishes once the network is back', async () => {
    const backend = fakeBackend();
    const clock = { now: clockNow() };
    const { renderer, onSubmitted } = await mount(
      realDataStore(clock),
      backend.api,
      () => clock.now,
    );
    await fill(renderer);
    await pressBroadcast(renderer);
    await settle(() => text(renderer.root).includes('has not been sent yet'));
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain('has not been sent yet');

    backend.state.up = true;
    clock.now += 3600;
    await settle(() => onSubmitted.mock.calls.length > 0);
    expect(onSubmitted).toHaveBeenCalledOnce();
    expect(new Set(backend.state.calls).size).toBe(1);
    expect(backend.state.stored.size).toBe(1);
  });

  /** A photo library whose n-th pick is a different picture, encoded as a different thumbnail. */
  function fakePhotoPort() {
    const state = { picks: 0 };
    const port: PhotoPort = {
      pick: async () => {
        state.picks += 1;
        return { uri: `file://picked-${state.picks}.jpg`, width: 4000, height: 3000 };
      },
      resize: async (picked) => ({
        mime: 'image/jpeg',
        b64: picked.uri.endsWith('-1.jpg')
          ? 'QUJD'
          : picked.uri.endsWith('-2.jpg')
            ? 'REVG'
            : 'R0hJ',
      }),
    };
    return { state, port };
  }
  const press = (renderer: ReactTestRenderer, label: string) =>
    act(async () => {
      const button = renderer.root.findAll(
        (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
      )[0]!;
      (button.props.onPress as () => void)();
    });
  const thumbnails = (renderer: ReactTestRenderer) =>
    renderer.root
      .findAll(
        (n) =>
          (n.type as unknown) === 'Image' && String(n.props.testID).startsWith('photo-thumbnail-'),
      )
      .map((n) => (n.props.source as { uri: string }).uri);

  test('with no photo port the photo section is not shown', async () => {
    const { renderer } = await mount(
      realDataStore({ now: clockNow() }),
      fakeBackend().api,
      clockNow,
    );
    expect(text(renderer.root)).not.toContain('Add photo');
  });

  test('takes two photos, refuses a third with a clear message, and sends the two', async () => {
    const backend = fakeBackend();
    backend.state.up = true;
    const photos = fakePhotoPort();
    const { renderer, onSubmitted } = await mount(
      realDataStore({ now: clockNow() }),
      backend.api,
      clockNow,
      photos.port,
    );
    expect(text(renderer.root)).toContain('You can add up to 2.');

    await press(renderer, 'Add photo');
    expect(thumbnails(renderer)).toEqual(['data:image/jpeg;base64,QUJD']);
    await press(renderer, 'Add another photo');
    expect(thumbnails(renderer)).toEqual([
      'data:image/jpeg;base64,QUJD',
      'data:image/jpeg;base64,REVG',
    ]);
    expect(text(renderer.root)).not.toContain(PHOTO_LIMIT_ERROR);

    // The third: the library is not opened, nothing is replaced, and the reason is on screen.
    await press(renderer, 'Add another photo');
    expect(photos.state.picks).toBe(2);
    expect(thumbnails(renderer)).toHaveLength(2);
    expect(text(renderer.root)).toContain(PHOTO_LIMIT_ERROR);

    await fill(renderer);
    await pressBroadcast(renderer);
    await settle(() => onSubmitted.mock.calls.length === 1);
    expect(backend.state.requests).toHaveLength(1);
    expect(backend.state.requests[0]!.person.photos).toEqual([
      { mime: 'image/jpeg', w: 256, h: 192, b64: 'QUJD' },
      { mime: 'image/jpeg', w: 256, h: 192, b64: 'REVG' },
    ]);
  });

  test('removing a photo clears the message and makes room for another', async () => {
    const photos = fakePhotoPort();
    const { renderer } = await mount(
      realDataStore({ now: clockNow() }),
      fakeBackend().api,
      clockNow,
      photos.port,
    );
    await press(renderer, 'Add photo');
    await press(renderer, 'Add another photo');
    await press(renderer, 'Add another photo');
    expect(text(renderer.root)).toContain(PHOTO_LIMIT_ERROR);

    await press(renderer, 'Remove photo 1');
    expect(text(renderer.root)).not.toContain(PHOTO_LIMIT_ERROR);
    expect(thumbnails(renderer)).toEqual(['data:image/jpeg;base64,REVG']);

    await press(renderer, 'Add another photo');
    expect(photos.state.picks).toBe(3);
    expect(thumbnails(renderer)).toEqual([
      'data:image/jpeg;base64,REVG',
      'data:image/jpeg;base64,R0hJ',
    ]);
  });

  test('a report sent with no photo carries no photos member', async () => {
    const backend = fakeBackend();
    backend.state.up = true;
    const { renderer, onSubmitted } = await mount(
      realDataStore({ now: clockNow() }),
      backend.api,
      clockNow,
      fakePhotoPort().port,
    );
    await fill(renderer);
    await pressBroadcast(renderer);
    await settle(() => onSubmitted.mock.calls.length === 1);
    expect('photos' in backend.state.requests[0]!.person).toBe(false);
  });

  test('a refused report shows the failure and lets the reporter edit again', async () => {
    const api: ReportApi = {
      submitReport: async () => ({ kind: 'rejected', code: 'invalid_request', message: 'nope' }),
    };
    const { renderer, onSubmitted } = await mount(
      realDataStore({ now: clockNow() }),
      api,
      clockNow,
    );
    await fill(renderer);
    await pressBroadcast(renderer);
    await settle(() => text(renderer.root).includes('could not accept this report'));
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain('could not accept this report');
    expect(input(renderer, 'Their name, required').props.editable).toBe(true);
  });
});
