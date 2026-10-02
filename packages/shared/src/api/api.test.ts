import { describe, expect, test } from 'vitest';
import { MAX_RESPONSE_TEXT_CHARS } from '../constants';
import { classifyCriteriaEdit } from '../payload/widening';
import { DeviceRegistrationRequestSchema, DeviceRegistrationResponseSchema } from './devices';
import { API_ENDPOINTS, reportPath } from './endpoints';
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  ApiErrorBodySchema,
  apiError,
  isApiErrorCode,
  isRetryableError,
} from './errors';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  IdempotencyKeySchema,
} from './idempotency';
import {
  applyReportPatch,
  ReportEndRequestSchema,
  ReportPatchRequestSchema,
  ReportResponseSchema,
  ReportSubmitRequestSchema,
  type EditableReport,
  type Report,
} from './reports';
import {
  ResponseListQuerySchema,
  ResponseListResponseSchema,
  ResponseSubmitRequestSchema,
  ResponseSubmitResponseSchema,
} from './responses';

const QUERY_ID = '01JB3Z6Q7W8X9Y0ZABCDEFGHJK';
const RESPONSE_ID = '01JB3Z6Q7W8X9Y0ZABCDEFGHJR';

const submit = {
  center: { lat: 12.9716, lon: 77.5946 },
  radius_m: 100,
  window: { from: 1789880000, to: 1789881800 },
  person: { name: 'Alex Rivera', description: 'Blue jacket.' },
  reporter_phone: '+15550000000',
};

const report: Report = {
  query_id: QUERY_ID,
  revision: 1,
  status: 'active',
  created_at: 1789900000,
  updated_at: 1789900000,
  expires_at: 1792492000,
  ended_at: null,
  ...submit,
};

describe('endpoints', () => {
  test('are exactly the six in plan 9.2', () => {
    const table = Object.fromEntries(
      Object.entries(API_ENDPOINTS).map(([name, e]) => [name, `${e.method} ${e.path}`]),
    );
    expect(table).toEqual({
      registerDevice: 'POST /v1/devices',
      submitReport: 'POST /v1/reports',
      patchReport: 'PATCH /v1/reports/:id',
      endReport: 'POST /v1/reports/:id/end',
      listResponses: 'GET /v1/reports/:id/responses',
      submitResponse: 'POST /v1/responses',
    });
  });

  test('the requests that create or change something need an idempotency key', () => {
    const required = Object.entries(API_ENDPOINTS)
      .filter(([, endpoint]) => endpoint.idempotencyKey === 'required')
      .map(([name]) => name);
    expect(required.sort()).toEqual(['patchReport', 'submitReport', 'submitResponse']);
  });

  test('creating endpoints answer 201, the rest 200', () => {
    expect(API_ENDPOINTS.submitReport.successStatus).toBe(201);
    expect(API_ENDPOINTS.submitResponse.successStatus).toBe(201);
    expect(API_ENDPOINTS.patchReport.successStatus).toBe(200);
  });

  test('reportPath fills in the query id', () => {
    expect(reportPath('patchReport', QUERY_ID)).toBe(`/v1/reports/${QUERY_ID}`);
    expect(reportPath('endReport', QUERY_ID)).toBe(`/v1/reports/${QUERY_ID}/end`);
    expect(reportPath('listResponses', QUERY_ID)).toBe(`/v1/reports/${QUERY_ID}/responses`);
  });
});

describe('errors', () => {
  test('every code has exactly one HTTP status, and it is an error status', () => {
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual([...API_ERROR_CODES].sort());
    for (const status of Object.values(API_ERROR_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  test('apiError builds a body the schema accepts', () => {
    const body = apiError('edit_not_widening', 'radius_m may not shrink', {
      violations: ['radius_smaller'],
      request_id: 'req-1',
    });
    expect(body).toEqual({
      error: {
        code: 'edit_not_widening',
        message: 'radius_m may not shrink',
        violations: ['radius_smaller'],
        request_id: 'req-1',
      },
    });
    expect(ApiErrorBodySchema.parse(body)).toEqual(body);
  });

  test('an app that predates a code can still read the error', () => {
    const fromNewerServer = { error: { code: 'report_under_review', message: 'held' } };
    expect(ApiErrorBodySchema.safeParse(fromNewerServer).success).toBe(true);
    expect(isApiErrorCode('report_under_review')).toBe(false);
    expect(isApiErrorCode('rate_limited')).toBe(true);
  });

  test('rejects a body that is not the error shape', () => {
    expect(ApiErrorBodySchema.safeParse({ message: 'oops' }).success).toBe(false);
    expect(ApiErrorBodySchema.safeParse({ error: { code: '', message: '' } }).success).toBe(false);
  });

  test('only transient failures are retryable', () => {
    const retryable = API_ERROR_CODES.filter(isRetryableError);
    expect(retryable.sort()).toEqual(
      ['idempotency_in_progress', 'internal', 'rate_limited', 'unavailable'].sort(),
    );
  });
});

describe('idempotency', () => {
  test('header names', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
    expect(IDEMPOTENCY_REPLAYED_HEADER).toBe('Idempotency-Replayed');
  });

  test('a key is a lowercase version 4 UUID', () => {
    expect(IdempotencyKeySchema.safeParse('3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34').success).toBe(
      true,
    );
    for (const bad of [
      '3F2B8C1E-9D4A-4B6F-8A1C-0E5D7F9B2A34',
      '3f2b8c1e-9d4a-1b6f-8a1c-0e5d7f9b2a34',
      '3f2b8c1e9d4a4b6f8a1c0e5d7f9b2a34',
      '',
    ]) {
      expect(IdempotencyKeySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('device registration', () => {
  test('a bystander registers with no push token', () => {
    const request = { platform: 'android', app_version: '1.0.0' };
    expect(DeviceRegistrationRequestSchema.parse(request)).toEqual(request);
  });

  test('a reporter registers with one', () => {
    const request = {
      platform: 'ios',
      app_version: '1.0.0',
      push: { provider: 'apns', token: 'abc123' },
    };
    expect(DeviceRegistrationRequestSchema.parse(request)).toEqual(request);
  });

  test('the device id is not part of the body', () => {
    const parsed = DeviceRegistrationRequestSchema.parse({
      platform: 'android',
      app_version: '1.0.0',
      device_id: '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34',
    });
    expect('device_id' in parsed).toBe(false);
  });

  test.each([
    [{ platform: 'windows', app_version: '1' }],
    [{ platform: 'android' }],
    [{ platform: 'android', app_version: '1', push: { provider: 'sms', token: 'x' } }],
    [{ platform: 'android', app_version: '1', push: { provider: 'fcm', token: '' } }],
  ])('rejects %j', (request) => {
    expect(DeviceRegistrationRequestSchema.safeParse(request).success).toBe(false);
  });

  test('response shape', () => {
    const response = { device_id: '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34', push_registered: false };
    expect(DeviceRegistrationResponseSchema.parse(response)).toEqual(response);
  });
});

describe('report submit', () => {
  test('accepts a complete report, with or without the verification seam', () => {
    expect(ReportSubmitRequestSchema.parse(submit)).toEqual(submit);
    const verified = { ...submit, phone_verification: 'opaque-proof' };
    expect(ReportSubmitRequestSchema.parse(verified)).toEqual(verified);
  });

  test.each([
    ['no phone', { reporter_phone: undefined }],
    ['an unformatted phone', { reporter_phone: '555-0000' }],
    ['no person', { person: undefined }],
    ['a reversed window', { window: { from: 2, to: 1 } }],
    ['a radius over the cap', { radius_m: 5_001 }],
    ['no centre', { center: undefined }],
  ])('rejects %s', (_label, changes) => {
    expect(ReportSubmitRequestSchema.safeParse({ ...submit, ...changes }).success).toBe(false);
  });

  test('the client does not choose ids, cells, expiry or revision', () => {
    const parsed = ReportSubmitRequestSchema.parse({
      ...submit,
      query_id: QUERY_ID,
      cells: ['8760145b4ffffff'],
      expires_at: 1,
      revision: 9,
    });
    expect(parsed).toEqual(submit);
  });

  test('the response wraps the report', () => {
    expect(ReportResponseSchema.parse({ report })).toEqual({ report });
    const ended = { ...report, status: 'ended', ended_at: 1789950000 };
    expect(ReportResponseSchema.parse({ report: ended })).toEqual({ report: ended });
    expect(
      ReportResponseSchema.safeParse({ report: { ...report, status: 'paused' } }).success,
    ).toBe(false);
  });

  test('ending takes an empty body', () => {
    expect(ReportEndRequestSchema.parse({})).toEqual({});
  });
});

describe('report patch', () => {
  const current: EditableReport = {
    center: submit.center,
    radius_m: submit.radius_m,
    window: submit.window,
    person: {
      name: 'Alex Rivera',
      description: 'Blue jacket.',
      photo: { mime: 'image/webp', w: 2, h: 2, b64: 'AAAA' },
    },
  };

  test('needs the revision it was made against', () => {
    expect(ReportPatchRequestSchema.safeParse({ radius_m: 200 }).success).toBe(false);
    expect(
      ReportPatchRequestSchema.safeParse({ expected_revision: 1, radius_m: 200 }).success,
    ).toBe(true);
  });

  test('must change something', () => {
    expect(ReportPatchRequestSchema.safeParse({ expected_revision: 1 }).success).toBe(false);
  });

  test('cannot change the phone number or the status', () => {
    const parsed = ReportPatchRequestSchema.parse({
      expected_revision: 1,
      radius_m: 200,
      reporter_phone: '+15559999999',
      status: 'ended',
    });
    expect(parsed).toEqual({ expected_revision: 1, radius_m: 200 });
  });

  test('a field left out is unchanged', () => {
    const next = applyReportPatch(current, { expected_revision: 1, radius_m: 250 });
    expect(next).toEqual({ ...current, radius_m: 250 });
  });

  test('person fields are patched one by one', () => {
    const next = applyReportPatch(current, {
      expected_revision: 1,
      person: { description: 'Blue jacket, red cap.' },
    });
    expect(next.person).toEqual({ ...current.person, description: 'Blue jacket, red cap.' });
  });

  test('photo: left out keeps it, null removes it, a value replaces it', () => {
    const kept = applyReportPatch(current, { expected_revision: 1, person: { name: 'A. Rivera' } });
    expect(kept.person.photo).toEqual(current.person.photo);

    const removed = applyReportPatch(current, { expected_revision: 1, person: { photo: null } });
    expect('photo' in removed.person).toBe(false);

    const replacement = { mime: 'image/jpeg' as const, w: 4, h: 4, b64: 'BBBB' };
    const replaced = applyReportPatch(current, {
      expected_revision: 1,
      person: { photo: replacement },
    });
    expect(replaced.person.photo).toEqual(replacement);
  });

  test('does not modify the report it is given', () => {
    const before = JSON.stringify(current);
    applyReportPatch(current, { expected_revision: 1, radius_m: 300, person: { photo: null } });
    expect(JSON.stringify(current)).toBe(before);
  });

  test('the patched result is what the widen-only rule judges', () => {
    const widen = applyReportPatch(current, { expected_revision: 1, radius_m: 300 });
    expect(classifyCriteriaEdit(current, widen)).toEqual({ kind: 'widened' });

    const narrow = applyReportPatch(current, {
      expected_revision: 1,
      window: { from: submit.window.from + 60, to: submit.window.to },
    });
    expect(classifyCriteriaEdit(current, narrow)).toEqual({
      kind: 'narrowed',
      violations: ['window_from_later'],
    });

    const describe = applyReportPatch(current, { expected_revision: 1, person: { name: 'Al' } });
    expect(classifyCriteriaEdit(current, describe)).toEqual({ kind: 'unchanged' });
  });
});

describe('responses', () => {
  test('a tip with a message and an explicit choice about the phone number', () => {
    const anonymous = { query_id: QUERY_ID, text: 'Saw him at the station.', phone: null };
    const shared = { ...anonymous, phone: '+15551112222' };
    expect(ResponseSubmitRequestSchema.parse(anonymous)).toEqual(anonymous);
    expect(ResponseSubmitRequestSchema.parse(shared)).toEqual(shared);
  });

  test('the phone choice can never be left implicit', () => {
    const request = { query_id: QUERY_ID, text: 'Saw him at the station.' };
    expect(ResponseSubmitRequestSchema.safeParse(request).success).toBe(false);
  });

  test('an empty message is allowed only together with a phone number', () => {
    const base = { query_id: QUERY_ID, text: '' };
    expect(ResponseSubmitRequestSchema.safeParse({ ...base, phone: '+15551112222' }).success).toBe(
      true,
    );
    expect(ResponseSubmitRequestSchema.safeParse({ ...base, phone: null }).success).toBe(false);
  });

  test('rejects an over-long message and a malformed query id', () => {
    const long = { query_id: QUERY_ID, text: 'x'.repeat(MAX_RESPONSE_TEXT_CHARS + 1), phone: null };
    expect(ResponseSubmitRequestSchema.safeParse(long).success).toBe(false);
    expect(
      ResponseSubmitRequestSchema.safeParse({ query_id: 'abc', text: 'hi', phone: null }).success,
    ).toBe(false);
  });

  test('the acknowledgement', () => {
    const ack = { response_id: RESPONSE_ID, received_at: 1789900500 };
    expect(ResponseSubmitResponseSchema.parse(ack)).toEqual(ack);
  });

  test('the list a reporter fetches', () => {
    const page = {
      responses: [
        { response_id: RESPONSE_ID, received_at: 1789900500, text: 'Saw him.', phone: null },
      ],
      cursor: 'c1',
      has_more: false,
    };
    expect(ResponseListResponseSchema.parse(page)).toEqual(page);
    const empty = { responses: [], cursor: null, has_more: false };
    expect(ResponseListResponseSchema.parse(empty)).toEqual(empty);
    expect(ResponseListQuerySchema.parse({})).toEqual({});
    expect(ResponseListQuerySchema.parse({ after: 'c1' })).toEqual({ after: 'c1' });
  });
});
