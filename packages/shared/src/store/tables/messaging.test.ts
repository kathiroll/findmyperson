import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Report, ReportSubmitRequest } from '../../api/reports';
import type { ReceivedResponse } from '../../api/responses';
import { OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC } from '../../constants';
import type { PersonPhoto } from '../../payload/query';
import { openMemoryDb } from '../../testing/memoryDb';
import { StoreRowError } from '../driver';
import { migrate, readSchemaVersion, SCHEMA_VERSION } from '../migrations';
import { KV_KEYS, kvDelete, kvGet, kvSet, shardGenerationKey } from './kv';
import {
  deleteFinishedResponsesBefore,
  enqueueResponse,
  getResponseForQuery,
  listDueResponses,
  markResponseFailed,
  markResponseRetry,
  markResponseSending,
  markResponseSent,
  requeueInterruptedResponses,
  type NewOutboundResponse,
} from './outboundResponse';
import {
  applyServerReport,
  enqueueOwnReport,
  getOwnReport,
  getOwnReportByQueryId,
  listDueOwnReports,
  listOwnReports,
  markOwnReportAcknowledged,
  markOwnReportFailed,
  markOwnReportRetry,
  markOwnReportSending,
  requeueInterruptedOwnReports,
  setResponsesCursor,
} from './ownReport';
import {
  countUnreadResponses,
  listReceivedResponses,
  markResponsesRead,
  saveReceivedResponses,
} from './receivedResponse';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

const QUERY_ID = '01JB3Z6Q7W8X9Y0ZABCDEFGHJK';
const OTHER_QUERY_ID = '01JB3Z6Q7W8X9Y0ZABCDEFGHJQ';
const KEY_A = '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34';
const KEY_B = '7a1d4e2f-6b3c-4d5e-9f8a-1b2c3d4e5f60';

const tip = (changes: Partial<NewOutboundResponse> = {}): NewOutboundResponse => ({
  query_id: QUERY_ID,
  idempotency_key: KEY_A,
  text: 'Saw him at the station around six.',
  phone: null,
  ...changes,
});

describe('outbound_response', () => {
  test('a queued tip is due immediately and keeps the choice about the phone number', async () => {
    const anonymous = await enqueueResponse(db, tip(), 1000);
    expect(anonymous).toEqual({
      id: 1,
      ...tip(),
      state: 'queued',
      attempts: 0,
      next_attempt_at: 1000,
      last_error: null,
      response_id: null,
      created_at: 1000,
      sent_at: null,
    });
    const shared = await enqueueResponse(
      db,
      tip({ query_id: OTHER_QUERY_ID, idempotency_key: KEY_B, phone: '+15551112222' }),
      1000,
    );
    expect(shared?.phone).toBe('+15551112222');
    expect(await db.execute('SELECT share_phone FROM outbound_response ORDER BY id')).toEqual([
      { share_phone: 0 },
      { share_phone: 1 },
    ]);
  });

  test('one tip per report: a second enqueue writes nothing', async () => {
    await enqueueResponse(db, tip(), 1000);
    const second = tip({ idempotency_key: KEY_B, text: 'Changed my mind.' });
    expect(await enqueueResponse(db, second, 2000)).toBeNull();
    expect((await getResponseForQuery(db, QUERY_ID))?.text).toBe(tip().text);
  });

  test('an idempotency key cannot be reused for another report', async () => {
    await enqueueResponse(db, tip(), 1000);
    await expect(enqueueResponse(db, tip({ query_id: OTHER_QUERY_ID }), 1000)).rejects.toThrow(
      /UNIQUE/,
    );
  });

  test('happy path: queued, sending, sent', async () => {
    const queued = await enqueueResponse(db, tip(), 1000);
    const id = queued?.id ?? -1;
    expect((await listDueResponses(db, 1000)).map((row) => row.id)).toEqual([id]);

    expect(await markResponseSending(db, id)).toBe(true);
    expect(await listDueResponses(db, 9999)).toEqual([]);
    // A second worker cannot take a tip that is already being sent.
    expect(await markResponseSending(db, id)).toBe(false);

    expect(await markResponseSent(db, id, '01JB3Z6Q7W8X9Y0ZABCDEFGHJR', 1005)).toBe(true);
    expect(await getResponseForQuery(db, QUERY_ID)).toMatchObject({
      state: 'sent',
      attempts: 1,
      response_id: '01JB3Z6Q7W8X9Y0ZABCDEFGHJR',
      sent_at: 1005,
      next_attempt_at: null,
      idempotency_key: KEY_A,
    });
  });

  test('a retryable failure waits for its next attempt and keeps the same key', async () => {
    const id = (await enqueueResponse(db, tip(), 1000))?.id ?? -1;
    await markResponseSending(db, id);
    expect(await markResponseRetry(db, id, 'unavailable', 1600)).toBe(true);
    expect(await listDueResponses(db, 1599)).toEqual([]);
    const [due] = await listDueResponses(db, 1600);
    expect(due).toMatchObject({
      state: 'queued',
      attempts: 1,
      last_error: 'unavailable',
      idempotency_key: KEY_A,
    });
    await markResponseSending(db, id);
    expect((await getResponseForQuery(db, QUERY_ID))?.attempts).toBe(2);
  });

  test('a final failure is never retried', async () => {
    const id = (await enqueueResponse(db, tip(), 1000))?.id ?? -1;
    await markResponseSending(db, id);
    expect(await markResponseFailed(db, id, 'report_not_active')).toBe(true);
    expect(await listDueResponses(db, 99_999)).toEqual([]);
    expect(await getResponseForQuery(db, QUERY_ID)).toMatchObject({
      state: 'failed',
      last_error: 'report_not_active',
      next_attempt_at: null,
    });
  });

  test('outcomes are only recorded for an attempt that is in flight', async () => {
    const id = (await enqueueResponse(db, tip(), 1000))?.id ?? -1;
    expect(await markResponseSent(db, id, 'x', 1)).toBe(false);
    expect(await markResponseRetry(db, id, 'network', 1)).toBe(false);
    expect(await markResponseFailed(db, id, 'forbidden')).toBe(false);
    expect((await getResponseForQuery(db, QUERY_ID))?.state).toBe('queued');
  });

  test('a tip caught mid-send by a killed process is queued again at startup', async () => {
    const id = (await enqueueResponse(db, tip(), 1000))?.id ?? -1;
    await markResponseSending(db, id);
    expect(await requeueInterruptedResponses(db, 5000)).toBe(1);
    expect(await listDueResponses(db, 5000)).toMatchObject([
      { id, state: 'queued', attempts: 1, idempotency_key: KEY_A },
    ]);
    expect(await requeueInterruptedResponses(db, 5000)).toBe(0);
  });

  test('the purge removes finished tips after the retention period and nothing else', async () => {
    const week = OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC;
    const sent = (await enqueueResponse(db, tip(), 1000))?.id ?? -1;
    await markResponseSending(db, sent);
    await markResponseSent(db, sent, 'r1', 2000);
    await enqueueResponse(db, tip({ query_id: OTHER_QUERY_ID, idempotency_key: KEY_B }), 1000);

    expect(await deleteFinishedResponsesBefore(db, 2000)).toBe(0);
    expect(await deleteFinishedResponsesBefore(db, 2000 + week)).toBe(1);
    // The tip still waiting to be sent is kept however old it is.
    expect((await getResponseForQuery(db, OTHER_QUERY_ID))?.state).toBe('queued');
    expect(await getResponseForQuery(db, QUERY_ID)).toBeNull();
  });

  test('the schema refuses a shared flag that disagrees with the phone column', async () => {
    await expect(
      db.execute(
        `INSERT INTO outbound_response (query_id, idempotency_key, text, share_phone, phone, state, created_at)
         VALUES (?, ?, 'x', 1, NULL, 'queued', 1)`,
        [QUERY_ID, KEY_A],
      ),
    ).rejects.toThrow(/CHECK/);
  });
});

const request: ReportSubmitRequest = {
  center: { lat: 12.9716, lon: 77.5946 },
  radius_m: 100,
  window: { from: 1789880000, to: 1789881800 },
  person: { name: 'Alex Rivera', description: 'Blue jacket.' },
  reporter_phone: '+15550000000',
};

const serverReport = (changes: Partial<Report> = {}): Report => ({
  query_id: QUERY_ID,
  revision: 1,
  status: 'active',
  created_at: 1789900000,
  updated_at: 1789900000,
  expires_at: 1792492000,
  ended_at: null,
  ...request,
  ...changes,
});

describe('own_report', () => {
  test('a queued report holds the request and no server state yet', async () => {
    const queued = await enqueueOwnReport(db, KEY_A, request, 1000);
    expect(queued).toEqual({
      id: 1,
      idempotency_key: KEY_A,
      query_id: null,
      state: 'queued',
      request,
      report: null,
      attempts: 0,
      next_attempt_at: 1000,
      last_error: null,
      responses_cursor: null,
      created_at: 1000,
      updated_at: 1000,
    });
    expect(await getOwnReport(db, queued.id)).toEqual(queued);
    expect(await listDueOwnReports(db, 1000)).toEqual([queued]);
  });

  test('acknowledgement gives the row its query id, its state and the server report', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    expect(await markOwnReportSending(db, id, 1001)).toBe(true);
    expect(await markOwnReportSending(db, id, 1001)).toBe(false);
    expect(await markOwnReportAcknowledged(db, id, serverReport(), 1002)).toBe(true);

    const stored = await getOwnReportByQueryId(db, QUERY_ID);
    expect(stored).toMatchObject({
      id,
      state: 'active',
      query_id: QUERY_ID,
      report: serverReport(),
      attempts: 1,
      next_attempt_at: null,
      updated_at: 1002,
    });
    expect(await listDueOwnReports(db, 99_999)).toEqual([]);
  });

  // The photos are inside request_json and report_json, so two of them need no column and no
  // migration: the schema version is still 1.
  test('a report with two photos is queued and acknowledged whole', async () => {
    const photos: PersonPhoto[] = [
      { mime: 'image/webp', w: 256, h: 192, b64: 'AAAA' },
      { mime: 'image/jpeg', w: 192, h: 256, b64: 'BBBB' },
    ];
    const withPhotos = { ...request, person: { ...request.person, photos } };
    const { id } = await enqueueOwnReport(db, KEY_A, withPhotos, 1000);
    expect((await getOwnReport(db, id))?.request.person.photos).toEqual(photos);

    await markOwnReportSending(db, id, 1001);
    await markOwnReportAcknowledged(db, id, serverReport({ person: withPhotos.person }), 1002);
    expect((await getOwnReportByQueryId(db, QUERY_ID))?.report?.person.photos).toEqual(photos);
    expect(await readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(1);
  });

  test('a stored request with three photos is an error, not a report', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    const photo = { mime: 'image/webp', w: 1, h: 1, b64: 'AAAA' };
    const three = { ...request, person: { ...request.person, photos: [photo, photo, photo] } };
    await db.execute('UPDATE own_report SET request_json = ? WHERE id = ?', [
      JSON.stringify(three),
      id,
    ]);
    await expect(getOwnReport(db, id)).rejects.toBeInstanceOf(StoreRowError);
  });

  test('offline: a failed attempt is retried later with the same idempotency key', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    await markOwnReportSending(db, id, 1001);
    expect(await markOwnReportRetry(db, id, 'network', 1300, 1002)).toBe(true);
    expect(await listDueOwnReports(db, 1299)).toEqual([]);
    expect(await listDueOwnReports(db, 1300)).toMatchObject([
      { id, state: 'queued', attempts: 1, last_error: 'network', idempotency_key: KEY_A },
    ]);
  });

  test('a final failure leaves a row the screen can show, with no query id', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    await markOwnReportSending(db, id, 1001);
    expect(await markOwnReportFailed(db, id, 'rate_limited', 1002)).toBe(true);
    expect(await getOwnReport(db, id)).toMatchObject({
      state: 'failed',
      query_id: null,
      report: null,
      last_error: 'rate_limited',
    });
    expect(await listDueOwnReports(db, 99_999)).toEqual([]);
  });

  test('a submit caught mid-send by a killed process is queued again at startup', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    await markOwnReportSending(db, id, 1001);
    expect(await requeueInterruptedOwnReports(db, 5000)).toBe(1);
    expect(await listDueOwnReports(db, 5000)).toMatchObject([{ id, idempotency_key: KEY_A }]);
  });

  test('an edit or an end is recorded from the server answer', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    await markOwnReportSending(db, id, 1001);
    await markOwnReportAcknowledged(db, id, serverReport(), 1002);

    const widened = serverReport({ revision: 2, radius_m: 400, updated_at: 1789900500 });
    expect(await applyServerReport(db, widened, 2000)).toBe(true);
    expect((await getOwnReport(db, id))?.report?.radius_m).toBe(400);

    const ended = serverReport({
      revision: 2,
      radius_m: 400,
      status: 'ended',
      ended_at: 1789901000,
    });
    expect(await applyServerReport(db, ended, 3000)).toBe(true);
    expect(await getOwnReport(db, id)).toMatchObject({ state: 'ended', updated_at: 3000 });
  });

  test('an older server answer never overwrites a newer one', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    await markOwnReportSending(db, id, 1001);
    await markOwnReportAcknowledged(db, id, serverReport({ revision: 3, radius_m: 900 }), 1002);
    expect(await applyServerReport(db, serverReport({ revision: 2, radius_m: 400 }), 2000)).toBe(
      false,
    );
    expect((await getOwnReport(db, id))?.report?.radius_m).toBe(900);
  });

  test('a server report for a query this device never filed is ignored', async () => {
    expect(await applyServerReport(db, serverReport(), 2000)).toBe(false);
    expect(await listOwnReports(db)).toEqual([]);
  });

  test('stores the response cursor against an acknowledged report only', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    expect(await setResponsesCursor(db, QUERY_ID, 'c1', 1500)).toBe(false);
    await markOwnReportSending(db, id, 1001);
    await markOwnReportAcknowledged(db, id, serverReport(), 1002);
    expect(await setResponsesCursor(db, QUERY_ID, 'c1', 1500)).toBe(true);
    expect((await getOwnReport(db, id))?.responses_cursor).toBe('c1');
  });

  test('lists newest first; one idempotency key is one report', async () => {
    await enqueueOwnReport(db, KEY_A, request, 1000);
    await enqueueOwnReport(db, KEY_B, request, 2000);
    expect((await listOwnReports(db)).map((row) => row.idempotency_key)).toEqual([KEY_B, KEY_A]);
    await expect(enqueueOwnReport(db, KEY_A, request, 3000)).rejects.toThrow(/UNIQUE/);
  });

  test('the schema ties the query id to the acknowledged states', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    await expect(
      db.execute("UPDATE own_report SET state = 'active' WHERE id = ?", [id]),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.execute('UPDATE own_report SET query_id = ? WHERE id = ?', [QUERY_ID, id]),
    ).rejects.toThrow(/CHECK/);
  });

  test('a stored request that no longer matches the schema is an error', async () => {
    const { id } = await enqueueOwnReport(db, KEY_A, request, 1000);
    await db.execute("UPDATE own_report SET request_json = '{}' WHERE id = ?", [id]);
    await expect(getOwnReport(db, id)).rejects.toBeInstanceOf(StoreRowError);
  });
});

const received = (response_id: string, received_at: number, phone: string | null = null) =>
  ({ response_id, received_at, text: `tip ${response_id}`, phone }) satisfies ReceivedResponse;

describe('received_response', () => {
  const R1 = '01JB3Z6Q7W8X9Y0ZABCDEFGHR1';
  const R2 = '01JB3Z6Q7W8X9Y0ZABCDEFGHR2';
  const R3 = '01JB3Z6Q7W8X9Y0ZABCDEFGHR3';

  test('stores a page and lists it oldest first', async () => {
    const page = [received(R2, 200, '+15551112222'), received(R1, 100)];
    expect(await saveReceivedResponses(db, QUERY_ID, page, 900)).toBe(2);
    expect(await listReceivedResponses(db, QUERY_ID)).toEqual([
      { ...received(R1, 100), query_id: QUERY_ID, fetched_at: 900, read_at: null },
      { ...received(R2, 200, '+15551112222'), query_id: QUERY_ID, fetched_at: 900, read_at: null },
    ]);
  });

  test('fetching the same tips again stores nothing new and keeps their read state', async () => {
    await saveReceivedResponses(db, QUERY_ID, [received(R1, 100)], 900);
    await markResponsesRead(db, QUERY_ID, 950);
    const again = [received(R1, 100), received(R2, 200)];
    expect(await saveReceivedResponses(db, QUERY_ID, again, 1000)).toBe(1);
    expect(await listReceivedResponses(db, QUERY_ID)).toMatchObject([
      { response_id: R1, fetched_at: 900, read_at: 950 },
      { response_id: R2, fetched_at: 1000, read_at: null },
    ]);
  });

  test('unread count and mark-read are per report', async () => {
    await saveReceivedResponses(db, QUERY_ID, [received(R1, 100), received(R2, 200)], 900);
    await saveReceivedResponses(db, OTHER_QUERY_ID, [received(R3, 300)], 900);
    expect(await countUnreadResponses(db, QUERY_ID)).toBe(2);
    expect(await markResponsesRead(db, QUERY_ID, 950)).toBe(2);
    expect(await markResponsesRead(db, QUERY_ID, 999)).toBe(0);
    expect(await countUnreadResponses(db, QUERY_ID)).toBe(0);
    expect(await countUnreadResponses(db, OTHER_QUERY_ID)).toBe(1);
  });
});

describe('kv', () => {
  test('get, set, overwrite, delete', async () => {
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBeNull();
    await kvSet(db, KV_KEYS.purgeLastRunAt, '1000');
    await kvSet(db, KV_KEYS.purgeLastRunAt, '2000');
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe('2000');
    expect(await kvDelete(db, KV_KEYS.purgeLastRunAt)).toBe(true);
    expect(await kvDelete(db, KV_KEYS.purgeLastRunAt)).toBe(false);
  });

  test('no two registered keys collide', () => {
    const keys = [...Object.values(KV_KEYS), shardGenerationKey('8560145bfffffff')];
    expect(new Set(keys).size).toBe(keys.length);
    expect(shardGenerationKey('8560145bfffffff')).toBe('fetch.shard_generation.8560145bfffffff');
  });
});
