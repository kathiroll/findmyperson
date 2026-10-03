import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  formatDeviceAuthorization,
  type Report,
  type ReportSubmitRequest,
} from '@findmyperson/shared';
import { buildApp } from './app';
import { ServerDb } from './db';
import { createDeviceAllowListOperatorPolicy } from './operator';
import type { PendingReportAlert } from './alerts';

const REPORTER = '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34';
const BYSTANDER = '4a2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a35';
const BYSTANDER_2 = '5a2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a36';
const CAPTAIN = '6a2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a37';

const NOW = 1_789_900_000;

const submitBody: ReportSubmitRequest = {
  center: { lat: 12.9716, lon: 77.5946 },
  radius_m: 100,
  window: { from: NOW - 3_600, to: NOW - 1_800 },
  person: { name: 'Alex Rivera', description: 'Blue jacket.' },
  reporter_phone: '+15550000000',
};

let db: ServerDb;
let app: FastifyInstance;
let alerts: PendingReportAlert[];
let keyCounter = 0;

/** A distinct, valid version 4 UUID per call. */
function newKey(): string {
  keyCounter += 1;
  return `7a2b8c1e-9d4a-4b6f-8a1c-${String(keyCounter).padStart(12, '0')}`;
}

beforeEach(() => {
  db = new ServerDb();
  alerts = [];
  app = buildApp({
    db,
    now: () => NOW,
    operator: createDeviceAllowListOperatorPolicy([CAPTAIN]),
    alerter: { reportPending: (alert) => void alerts.push(alert) },
  });
});

afterEach(async () => {
  await app.close();
  db.close();
});

async function call(
  device: string | null,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  key?: string,
) {
  const headers: Record<string, string> = {};
  if (device !== null) {
    headers['authorization'] = formatDeviceAuthorization(device);
  }
  if (key !== undefined) {
    headers['idempotency-key'] = key;
  }
  const response = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json(), headers: response.headers };
}

async function submitReport(body: ReportSubmitRequest = submitBody): Promise<Report> {
  const res = await call(REPORTER, 'POST', '/v1/reports', body, newKey());
  expect(res.status).toBe(201);
  return res.body.report as Report;
}

async function release(queryId: string): Promise<void> {
  const res = await call(CAPTAIN, 'POST', `/v1/operator/reports/${queryId}/release`);
  expect(res.status).toBe(200);
}

describe('authentication', () => {
  test('a request with no device identity is 401 in the shared error shape', async () => {
    const res = await call(null, 'POST', '/v1/reports', submitBody, newKey());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });
});

describe('device registration', () => {
  test('registers the calling device and reports whether a push token is held', async () => {
    const plain = await call(BYSTANDER, 'POST', '/v1/devices', {
      platform: 'android',
      app_version: '1.0.0',
    });
    expect(plain.body).toEqual({ device_id: BYSTANDER, push_registered: false });
    const withPush = await call(REPORTER, 'POST', '/v1/devices', {
      platform: 'ios',
      app_version: '1.0.0',
      push: { provider: 'apns', token: 'abc' },
    });
    expect(withPush.body).toEqual({ device_id: REPORTER, push_registered: true });
  });

  test('rejects an invalid body', async () => {
    const res = await call(BYSTANDER, 'POST', '/v1/devices', { platform: 'windows' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('report lifecycle: the manual-review gate', () => {
  test('a submitted report lands pending, is alerted to the operator, and is not broadcastable', async () => {
    const report = await submitReport();
    expect(report.review_state).toBe('pending');
    expect(db.getReport(report.query_id)?.review_state).toBe('pending');
    expect(alerts).toEqual([
      { query_id: report.query_id, reporter_phone: '+15550000000', created_at: NOW },
    ]);
    expect(db.listBroadcastable(NOW)).toEqual([]);
  });

  test('an idempotent replay of the submit does not alert twice', async () => {
    const key = newKey();
    await call(REPORTER, 'POST', '/v1/reports', submitBody, key);
    const replay = await call(REPORTER, 'POST', '/v1/reports', submitBody, key);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(alerts).toHaveLength(1);
  });

  test('a pending report is invisible to every unprivileged caller', async () => {
    const report = await submitReport();
    const id = report.query_id;
    // Another device cannot read it, edit it, end it or respond to it, and gets the same answer
    // as for an id that does not exist.
    for (const [method, url, payload] of [
      ['GET', `/v1/reports/${id}`, undefined],
      ['GET', `/v1/reports/${id}/responses`, undefined],
      ['PATCH', `/v1/reports/${id}`, { expected_revision: 1, radius_m: 200 }],
      ['POST', `/v1/reports/${id}/end`, {}],
    ] as const) {
      const res = await call(
        BYSTANDER,
        method,
        url,
        payload,
        method === 'PATCH' ? newKey() : undefined,
      );
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    const respond = await call(
      BYSTANDER,
      'POST',
      '/v1/responses',
      { query_id: id, text: 'saw him', phone: null },
      newKey(),
    );
    expect(respond.status).toBe(404);
    // Operator routes are closed to them too.
    expect((await call(BYSTANDER, 'GET', '/v1/operator/reports')).status).toBe(403);
    expect((await call(BYSTANDER, 'POST', `/v1/operator/reports/${id}/release`)).status).toBe(403);
    expect((await call(REPORTER, 'POST', `/v1/operator/reports/${id}/release`)).status).toBe(403);
    expect(db.getReport(id)?.review_state).toBe('pending');
    expect(db.listBroadcastable(NOW)).toEqual([]);
  });

  test('nothing but an explicit release makes a report broadcastable', async () => {
    const report = await submitReport();
    // None of these may release it: reading, editing, ending is separate, registering.
    await call(REPORTER, 'GET', `/v1/reports/${report.query_id}`);
    await call(
      REPORTER,
      'PATCH',
      `/v1/reports/${report.query_id}`,
      { expected_revision: 1, radius_m: 300 },
      newKey(),
    );
    await call(REPORTER, 'POST', '/v1/devices', { platform: 'android', app_version: '1' });
    expect(db.listBroadcastable(NOW)).toEqual([]);

    await release(report.query_id);
    const live = db.listBroadcastable(NOW);
    expect(live.map((r) => r.query_id)).toEqual([report.query_id]);
    expect(live[0]?.review_state).toBe('released');
  });

  test('release is operator-only; a non-operator cannot release even their own report', async () => {
    const report = await submitReport();
    const res = await call(REPORTER, 'POST', `/v1/operator/reports/${report.query_id}/release`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  test('with no operator configured nobody can release', async () => {
    const closed = buildApp({ db, now: () => NOW });
    const report = await submitReport();
    const res = await closed.inject({
      method: 'POST',
      url: `/v1/operator/reports/${report.query_id}/release`,
      headers: { authorization: formatDeviceAuthorization(CAPTAIN) },
    });
    expect(res.statusCode).toBe(403);
    expect(db.listBroadcastable(NOW)).toEqual([]);
    await closed.close();
  });

  test('a rejected report never broadcasts, and its reporter sees the rejected state', async () => {
    const report = await submitReport();
    const rejected = await call(CAPTAIN, 'POST', `/v1/operator/reports/${report.query_id}/reject`);
    expect(rejected.status).toBe(200);
    const own = await call(REPORTER, 'GET', `/v1/reports/${report.query_id}`);
    expect(own.body.report.review_state).toBe('rejected');
    expect(db.listBroadcastable(NOW)).toEqual([]);
    // Final: it cannot be released afterwards, nor edited.
    const again = await call(CAPTAIN, 'POST', `/v1/operator/reports/${report.query_id}/release`);
    expect(again.status).toBe(409);
    const edit = await call(
      REPORTER,
      'PATCH',
      `/v1/reports/${report.query_id}`,
      { expected_revision: 1, radius_m: 200 },
      newKey(),
    );
    expect(edit.status).toBe(409);
    expect(db.listBroadcastable(NOW)).toEqual([]);
  });

  test('a released report cannot be rejected or released again', async () => {
    const report = await submitReport();
    await release(report.query_id);
    expect(
      (await call(CAPTAIN, 'POST', `/v1/operator/reports/${report.query_id}/reject`)).status,
    ).toBe(409);
    expect(
      (await call(CAPTAIN, 'POST', `/v1/operator/reports/${report.query_id}/release`)).status,
    ).toBe(409);
    expect(db.getReport(report.query_id)?.review_state).toBe('released');
  });

  test('an ended pending report cannot be released later', async () => {
    const report = await submitReport();
    const ended = await call(REPORTER, 'POST', `/v1/reports/${report.query_id}/end`, {});
    expect(ended.body.report.status).toBe('ended');
    expect(ended.body.report.review_state).toBe('pending');
    const res = await call(CAPTAIN, 'POST', `/v1/operator/reports/${report.query_id}/release`);
    expect(res.status).toBe(409);
    expect(db.listBroadcastable(NOW)).toEqual([]);
  });

  test('ending a released report removes it from the broadcastable set', async () => {
    const report = await submitReport();
    await release(report.query_id);
    await call(REPORTER, 'POST', `/v1/reports/${report.query_id}/end`, {});
    expect(db.listBroadcastable(NOW)).toEqual([]);
  });

  test('an expired report is not broadcastable', async () => {
    const report = await submitReport();
    await release(report.query_id);
    expect(db.listBroadcastable(report.expires_at)).toEqual([]);
  });

  test('the operator can list reports awaiting review', async () => {
    const report = await submitReport();
    const res = await call(CAPTAIN, 'GET', '/v1/operator/reports');
    expect(res.body.reports.map((r: Report) => r.query_id)).toEqual([report.query_id]);
  });

  test('the database refuses any other review state', () => {
    expect(() =>
      db.insertPendingReport({
        query_id: '01JB3Z6Q7W8X9Y0ZABCDEFGHJK',
        reporter_device_id: REPORTER,
        created_at: NOW,
        updated_at: NOW,
        expires_at: NOW + 10,
        center: submitBody.center,
        radius_m: 1,
        window: submitBody.window,
        person: submitBody.person,
        reporter_phone: '+15550000000',
      }),
    ).not.toThrow();
    expect(() =>
      db.setReviewState('01JB3Z6Q7W8X9Y0ZABCDEFGHJK', 'active' as never, 'x', NOW),
    ).toThrow();
  });
});

describe('PATCH /v1/reports/:id', () => {
  test('applies a widening edit and bumps the revision, on a pending report', async () => {
    const report = await submitReport();
    const res = await call(
      REPORTER,
      'PATCH',
      `/v1/reports/${report.query_id}`,
      { expected_revision: 1, radius_m: 250 },
      newKey(),
    );
    expect(res.status).toBe(200);
    expect(res.body.report.radius_m).toBe(250);
    expect(res.body.report.revision).toBe(2);
    expect(res.body.report.review_state).toBe('pending');
  });

  test('rejects a non-widening edit with its violations and changes nothing', async () => {
    const report = await submitReport();
    const res = await call(
      REPORTER,
      'PATCH',
      `/v1/reports/${report.query_id}`,
      { expected_revision: 1, radius_m: 50 },
      newKey(),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('edit_not_widening');
    expect(res.body.error.violations).toContain('radius_smaller');
    expect(db.getReport(report.query_id)?.radius_m).toBe(100);
    expect(db.getReport(report.query_id)?.revision).toBe(1);
  });

  test('rejects a shrinking window', async () => {
    const report = await submitReport();
    const res = await call(
      REPORTER,
      'PATCH',
      `/v1/reports/${report.query_id}`,
      {
        expected_revision: 1,
        window: { from: submitBody.window.from + 60, to: submitBody.window.to },
      },
      newKey(),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.violations).toEqual(['window_from_later']);
  });

  test('a stale expected_revision is a conflict', async () => {
    const report = await submitReport();
    const res = await call(
      REPORTER,
      'PATCH',
      `/v1/reports/${report.query_id}`,
      { expected_revision: 9, radius_m: 250 },
      newKey(),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('revision_conflict');
  });

  test('is refused on an ended report', async () => {
    const report = await submitReport();
    await call(REPORTER, 'POST', `/v1/reports/${report.query_id}/end`, {});
    const res = await call(
      REPORTER,
      'PATCH',
      `/v1/reports/${report.query_id}`,
      { expected_revision: 1, radius_m: 250 },
      newKey(),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('report_not_active');
  });

  test('requires an Idempotency-Key, and replays the stored outcome for the same key', async () => {
    const report = await submitReport();
    const url = `/v1/reports/${report.query_id}`;
    const missing = await call(REPORTER, 'PATCH', url, { expected_revision: 1, radius_m: 250 });
    expect(missing.status).toBe(400);
    const key = newKey();
    const first = await call(REPORTER, 'PATCH', url, { expected_revision: 1, radius_m: 250 }, key);
    const replay = await call(REPORTER, 'PATCH', url, { expected_revision: 1, radius_m: 250 }, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(db.getReport(report.query_id)?.revision).toBe(2);
    const reused = await call(REPORTER, 'PATCH', url, { expected_revision: 2, radius_m: 300 }, key);
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
  });
});

describe('responses', () => {
  async function releasedReport(): Promise<string> {
    const report = await submitReport();
    await release(report.query_id);
    return report.query_id;
  }

  const respond = (device: string, queryId: string, text: string, phone: string | null = null) =>
    call(device, 'POST', '/v1/responses', { query_id: queryId, text, phone }, newKey());

  test('a delivered response is returned to the reporter, oldest first, with a cursor', async () => {
    const id = await releasedReport();
    const first = await respond(BYSTANDER, id, 'Saw him at the station.');
    expect(first.status).toBe(201);
    await respond(BYSTANDER_2, id, 'Maybe on platform 2.', '+15551112222');

    const list = await call(REPORTER, 'GET', `/v1/reports/${id}/responses`);
    expect(list.status).toBe(200);
    expect(list.body.responses.map((r: { text: string }) => r.text)).toEqual([
      'Saw him at the station.',
      'Maybe on platform 2.',
    ]);
    expect(list.body.responses[1].phone).toBe('+15551112222');
    expect(list.body.has_more).toBe(false);

    const next = await call(
      REPORTER,
      'GET',
      `/v1/reports/${id}/responses?after=${list.body.cursor}`,
    );
    expect(next.body.responses).toEqual([]);
    expect(next.body.cursor).toBe(list.body.cursor);
  });

  test('a second response from the same device to the same report is rejected', async () => {
    const id = await releasedReport();
    expect((await respond(BYSTANDER, id, 'first')).status).toBe(201);
    const second = await respond(BYSTANDER, id, 'second, different text');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_responded');
    const list = await call(REPORTER, 'GET', `/v1/reports/${id}/responses`);
    expect(list.body.responses).toHaveLength(1);
  });

  test('the one-per-pair rule is a database constraint, not just a handler check', async () => {
    const id = await releasedReport();
    const row = {
      query_id: id,
      device_id: BYSTANDER,
      text: 'x',
      phone: null,
      received_at: NOW,
      moderation: 'delivered' as const,
      held_reason: null,
    };
    db.insertResponse({ ...row, response_id: '01JB3Z6Q7W8X9Y0ZABCDEFGHJA' });
    expect(() => db.insertResponse({ ...row, response_id: '01JB3Z6Q7W8X9Y0ZABCDEFGHJB' })).toThrow(
      /UNIQUE/,
    );
  });

  test('there is no cap across different reports', async () => {
    const a = await releasedReport();
    const b = await releasedReport();
    expect((await respond(BYSTANDER, a, 'one')).status).toBe(201);
    expect((await respond(BYSTANDER, b, 'two')).status).toBe(201);
  });

  test.each([
    'Look at https://example.com/clue',
    'send me money and I will tell you',
    'UPI me at rahul@okaxis',
    'wallet 0x52908400098527886E0F7030069857D2E4169EE7',
  ])('a response containing a link or payment pattern is held, not delivered: %s', async (text) => {
    const id = await releasedReport();
    const res = await respond(BYSTANDER, id, text);
    // The sender is told nothing different.
    expect(res.status).toBe(201);
    const list = await call(REPORTER, 'GET', `/v1/reports/${id}/responses`);
    expect(list.body.responses).toEqual([]);
    const held = db.listHeldResponses();
    expect(held).toHaveLength(1);
    expect(held[0]?.text).toBe(text);
    expect(held[0]?.held_reason).not.toBeNull();
    // A held response still uses up the device's one response.
    expect((await respond(BYSTANDER, id, 'clean retry')).status).toBe(409);
  });

  test('a response may be empty only when a phone is shared', async () => {
    const id = await releasedReport();
    expect((await respond(BYSTANDER, id, '')).status).toBe(400);
    expect((await respond(BYSTANDER, id, '', '+15551112222')).status).toBe(201);
  });

  test('responses are refused once the report has ended', async () => {
    const id = await releasedReport();
    await call(REPORTER, 'POST', `/v1/reports/${id}/end`, {});
    const res = await respond(BYSTANDER, id, 'late');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('report_not_active');
  });

  test('only the reporter can read the responses', async () => {
    const id = await releasedReport();
    await respond(BYSTANDER, id, 'hello');
    expect((await call(BYSTANDER, 'GET', `/v1/reports/${id}/responses`)).status).toBe(404);
  });

  test('a response to an unknown report is not_found', async () => {
    const res = await respond(BYSTANDER, '01JB3Z6Q7W8X9Y0ZABCDEFGHJK', 'hello');
    expect(res.status).toBe(404);
  });

  test('a bad cursor is invalid_request', async () => {
    const id = await releasedReport();
    const res = await call(REPORTER, 'GET', `/v1/reports/${id}/responses?after=zzz`);
    expect(res.status).toBe(400);
  });
});
