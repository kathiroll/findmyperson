import { createHash } from 'node:crypto';
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
import { escapeHtml } from './operatorPage';

const REPORTER = '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34';
const BYSTANDER = '4a2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a35';
const BYSTANDER_2 = '5a2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a36';
const CAPTAIN = '6a2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a37';

const TOKEN = 'correct-horse-battery-staple-9f3a';
const START = 1_789_900_000;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

const submitBody: ReportSubmitRequest = {
  center: { lat: 12.9716, lon: 77.5946 },
  radius_m: 100,
  window: { from: START - 3_600, to: START - 1_800 },
  person: { name: 'Alex Rivera', description: 'Blue jacket.' },
  reporter_phone: '+15550000000',
};

let db: ServerDb;
let app: FastifyInstance;
let nowSec: number;
let keyCounter = 0;

function newKey(): string {
  keyCounter += 1;
  return `8a2b8c1e-9d4a-4b6f-8a1c-${String(keyCounter).padStart(12, '0')}`;
}

function start(operatorWebToken: string | undefined): void {
  db = new ServerDb();
  nowSec = START;
  app = buildApp({
    db,
    now: () => nowSec,
    operator: createDeviceAllowListOperatorPolicy([CAPTAIN]),
    operatorWebToken,
    alerter: { reportPending: () => undefined },
  });
}

beforeEach(() => start(TOKEN));

afterEach(async () => {
  await app.close();
  db.close();
});

/** A request from an app, as a device. */
async function api(
  device: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  key?: string,
) {
  const response = await app.inject({
    method,
    url,
    headers: {
      authorization: formatDeviceAuthorization(device),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: response.statusCode, body: response.json() };
}

async function submitReport(overrides: Partial<ReportSubmitRequest> = {}): Promise<string> {
  const res = await api(REPORTER, 'POST', '/v1/reports', { ...submitBody, ...overrides }, newKey());
  expect(res.status).toBe(201);
  return (res.body.report as Report).query_id;
}

const respond = (device: string, queryId: string, text: string, phone: string | null = null) =>
  api(device, 'POST', '/v1/responses', { query_id: queryId, text, phone }, newKey());

async function readResponses(queryId: string, after?: string) {
  const query = after === undefined ? '' : `?after=${after}`;
  const res = await api(REPORTER, 'GET', `/v1/reports/${queryId}/responses${query}`);
  return res.body as { responses: { text: string; response_id: string }[]; cursor: string | null };
}

/** Signs in the way the login form does and returns the cookie a browser would send back. */
async function signIn(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/operator/login',
    headers: FORM,
    payload: `token=${TOKEN}`,
  });
  expect(res.statusCode).toBe(303);
  expect(res.headers['location']).toBe('/operator');
  return String(res.headers['set-cookie']).split(';')[0] as string;
}

/** A page request from a browser. A button is a form with no fields. */
async function page(
  cookie: string | null,
  method: 'GET' | 'POST' = 'GET',
  url = '/operator',
  extraHeaders: Record<string, string> = {},
) {
  const response = await app.inject({
    method,
    url,
    headers: {
      ...(cookie === null ? {} : { cookie }),
      ...(method === 'POST' ? { ...FORM, 'content-length': '0' } : {}),
      ...extraHeaders,
    },
  });
  return { status: response.statusCode, html: response.body, headers: response.headers };
}

async function releasedReport(cookie: string): Promise<string> {
  const id = await submitReport();
  expect((await page(cookie, 'POST', `/operator/reports/${id}/release`)).status).toBe(303);
  return id;
}

describe('access', () => {
  test('without a session the page is the sign-in form and shows no report', async () => {
    await submitReport();
    const res = await page(null);
    expect(res.status).toBe(401);
    expect(res.html).toContain('name="token"');
    expect(res.html).not.toContain('Alex Rivera');
    expect(res.html).not.toContain('+15550000000');
  });

  test.each([undefined, '', '   ', 'too-short'])(
    'with the token unset, empty or too short (%j) every request is refused',
    async (configured) => {
      await app.close();
      db.close();
      start(configured);
      const id = await submitReport();
      expect((await page(null)).status).toBe(403);
      const login = await app.inject({
        method: 'POST',
        url: '/operator/login',
        headers: FORM,
        payload: `token=${encodeURIComponent(configured ?? '')}`,
      });
      expect(login.statusCode).toBe(403);
      expect(login.headers['set-cookie']).toBeUndefined();
      expect((await page(null, 'POST', `/operator/reports/${id}/release`)).status).toBe(403);
      expect(db.getReport(id)?.review_state).toBe('pending');
    },
  );

  test('a wrong token does not sign in', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/operator/login',
      headers: FORM,
      payload: 'token=not-the-operator-token',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('the right token signs in, and the cookie does not contain it', async () => {
    const cookie = await signIn();
    expect(cookie).not.toContain(TOKEN);
    const login = await app.inject({
      method: 'POST',
      url: '/operator/login',
      headers: FORM,
      payload: `token=${TOKEN}`,
    });
    expect(String(login.headers['set-cookie'])).toMatch(/; HttpOnly; SameSite=Lax; /);
    expect((await page(cookie)).status).toBe(200);
  });

  test('a forged, altered or expired cookie is refused', async () => {
    const cookie = await signIn();
    const [name, value] = cookie.split('=') as [string, string];
    const [expiresAt, signature] = value.split('.') as [string, string];
    const later = `${name}=${Number(expiresAt) + 3_600}.${signature}`;
    const flipped = `${name}=${expiresAt}.${signature.replace(/.$/, (c) => (c === '0' ? '1' : '0'))}`;
    for (const forged of [`${name}=${TOKEN}`, `${name}=`, later, flipped]) {
      expect((await page(forged)).status).toBe(401);
    }
    nowSec = Number(expiresAt);
    expect((await page(cookie)).status).toBe(401);
  });

  test('a decision without a session changes nothing', async () => {
    const id = await submitReport();
    for (const action of ['release', 'reject']) {
      expect((await page(null, 'POST', `/operator/reports/${id}/${action}`)).status).toBe(401);
    }
    expect(db.getReport(id)?.review_state).toBe('pending');
    expect(db.listBroadcastable(nowSec)).toEqual([]);
  });

  test("the API's device identity does not open the page, even the operator's", async () => {
    const res = await page(null, 'GET', '/operator', {
      authorization: formatDeviceAuthorization(CAPTAIN),
    });
    expect(res.status).toBe(401);
  });

  test('a POST sent by another site is refused even with the cookie', async () => {
    const cookie = await signIn();
    const id = await submitReport();
    const res = await page(cookie, 'POST', `/operator/reports/${id}/release`, {
      'sec-fetch-site': 'cross-site',
    });
    expect(res.status).toBe(403);
    expect(db.getReport(id)?.review_state).toBe('pending');
    const sameOrigin = await page(cookie, 'POST', `/operator/reports/${id}/release`, {
      'sec-fetch-site': 'same-origin',
    });
    expect(sameOrigin.status).toBe(303);
  });

  test('signing out clears the cookie', async () => {
    const cookie = await signIn();
    const res = await page(cookie, 'POST', '/operator/logout');
    expect(res.status).toBe(303);
    expect(String(res.headers['set-cookie'])).toMatch(/^fmp_operator_session=; .*Max-Age=0/);
  });

  test('the form parser is not added to the API', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices',
      headers: { ...FORM, authorization: formatDeviceAuthorization(BYSTANDER) },
      payload: 'platform=android&app_version=1.0.0',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('pending reports', () => {
  test('a pending report is listed with its fields, newest first', async () => {
    const cookie = await signIn();
    const older = await submitReport();
    nowSec += 600;
    const newer = await submitReport({
      person: {
        name: 'Sam Okafor',
        description: 'Green cap.\nWalks with a stick.',
        photo: { mime: 'image/jpeg', w: 2, h: 2, b64: '/9j/4AAQ' },
      },
      reporter_phone: '+919800000000',
    });
    nowSec += 300;
    const res = await page(cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.html).toContain('Pending reports (2)');
    for (const text of [
      'Alex Rivera',
      'Blue jacket.',
      '<a href="tel:+15550000000">+15550000000</a>',
      'within 100 m of 12.9716, 77.5946, between 2026-09-20 09:26 UTC and 2026-09-20 09:56 UTC',
      '2026-09-20 10:26 UTC (15 min ago)',
      'Sam Okafor',
      '<dd>Green cap.\nWalks with a stick.</dd>',
      '<a href="tel:+919800000000">+919800000000</a>',
      '2026-09-20 10:36 UTC (5 min ago)',
      '<img alt="Photo sent with the report" src="data:image/jpeg;base64,/9j/4AAQ">',
      `action="/operator/reports/${older}/release"`,
      `action="/operator/reports/${older}/reject"`,
    ]) {
      expect(res.html).toContain(text);
    }
    expect(res.html.indexOf(newer)).toBeLessThan(res.html.indexOf(older));
    // One photo was sent, so one is shown.
    expect(res.html.match(/<img /g)).toHaveLength(1);
  });

  test('releasing a report makes it broadcastable and takes it off the page', async () => {
    const cookie = await signIn();
    const id = await submitReport();
    expect(db.listBroadcastable(nowSec)).toEqual([]);
    const res = await page(cookie, 'POST', `/operator/reports/${id}/release`);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/operator?done=report-release');
    expect(db.listBroadcastable(nowSec).map((r) => r.query_id)).toEqual([id]);
    expect(db.getReport(id)).toMatchObject({
      review_state: 'released',
      reviewed_by: 'operator-web',
      reviewed_at: nowSec,
    });
    const after = await page(cookie, 'GET', String(res.headers['location']));
    expect(after.html).toContain('Report released.');
    expect(after.html).toContain('Pending reports (0)');
    expect(after.html).not.toContain(id);
    // The reporter sees the same decision through the API.
    const own = await api(REPORTER, 'GET', `/v1/reports/${id}`);
    expect(own.body.report.review_state).toBe('released');
  });

  test('rejecting a report leaves it out of the broadcast for good', async () => {
    const cookie = await signIn();
    const id = await submitReport();
    const res = await page(cookie, 'POST', `/operator/reports/${id}/reject`);
    expect(res.status).toBe(303);
    expect(db.getReport(id)?.review_state).toBe('rejected');
    expect(db.listBroadcastable(nowSec)).toEqual([]);
    expect((await page(cookie)).html).not.toContain(id);
    // Final: a later release is refused and changes nothing.
    const again = await page(cookie, 'POST', `/operator/reports/${id}/release`);
    expect(again.status).toBe(409);
    expect(again.html).toContain('Nothing changed: report is already rejected.');
    expect(db.listBroadcastable(nowSec)).toEqual([]);
  });

  test('a report the reporter ended cannot be released, and Release is not offered', async () => {
    const cookie = await signIn();
    const id = await submitReport();
    await api(REPORTER, 'POST', `/v1/reports/${id}/end`, {});
    const listed = await page(cookie);
    expect(listed.html).toContain('This report is ended; it can no longer be released.');
    expect(listed.html).not.toContain(`/operator/reports/${id}/release`);
    expect(listed.html).toContain(`/operator/reports/${id}/reject`);
    const res = await page(cookie, 'POST', `/operator/reports/${id}/release`);
    expect(res.status).toBe(409);
    expect(db.getReport(id)?.review_state).toBe('pending');
    expect(db.listBroadcastable(nowSec)).toEqual([]);
  });

  test('an unknown or malformed report id is not found', async () => {
    const cookie = await signIn();
    for (const id of ['01JB3Z6Q7W8X9Y0ZABCDEFGHJK', 'nonsense']) {
      expect((await page(cookie, 'POST', `/operator/reports/${id}/release`)).status).toBe(404);
    }
  });

  test('a notice is fixed text: a crafted link cannot put words on the page', async () => {
    const cookie = await signIn();
    const res = await page(cookie, 'GET', '/operator?done=%3Cb%3Ecall%20this%20number%3C%2Fb%3E');
    expect(res.status).toBe(200);
    expect(res.html).not.toContain('call this number');
  });
});

describe('held responses', () => {
  test('a held response is listed with its text, its report and why it was held', async () => {
    const cookie = await signIn();
    const id = await releasedReport(cookie);
    await respond(BYSTANDER, id, 'I saw him by the bus stop.');
    await respond(BYSTANDER_2, id, 'Photos at https://example.com/clue', '+15551112222');
    const held = db.listHeldResponses();
    expect(held).toHaveLength(1);
    const res = await page(cookie);
    expect(res.html).toContain('Held responses (1)');
    for (const text of [
      '<dd>Photos at https://example.com/clue</dd>',
      '<dd>contains a link</dd>',
      '<a href="tel:+15551112222">+15551112222</a>',
      `Alex Rivera, reporter <a href="tel:+15550000000">+15550000000</a> <code>${id}</code>`,
      `action="/operator/responses/${held[0]?.response_id}/release"`,
      `action="/operator/responses/${held[0]?.response_id}/reject"`,
    ]) {
      expect(res.html).toContain(text);
    }
    // A delivered response needs no decision and is not on the page.
    expect(res.html).not.toContain('I saw him by the bus stop.');
  });

  test('releasing a held response delivers it to the reporter', async () => {
    const cookie = await signIn();
    const id = await releasedReport(cookie);
    await respond(BYSTANDER, id, 'send me money and I will tell you');
    expect((await readResponses(id)).responses).toEqual([]);
    const responseId = db.listHeldResponses()[0]?.response_id as string;
    const res = await page(cookie, 'POST', `/operator/responses/${responseId}/release`);
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/operator?done=response-release');
    expect((await readResponses(id)).responses).toMatchObject([
      { response_id: responseId, text: 'send me money and I will tell you' },
    ]);
    expect(db.listHeldResponses()).toEqual([]);
    expect((await page(cookie)).html).toContain('Held responses (0)');
    // Final: it cannot be decided twice.
    expect((await page(cookie, 'POST', `/operator/responses/${responseId}/reject`)).status).toBe(
      409,
    );
    expect((await readResponses(id)).responses).toHaveLength(1);
  });

  test('a response released late still reaches a reporter who has read past it', async () => {
    const cookie = await signIn();
    const id = await releasedReport(cookie);
    await respond(BYSTANDER, id, 'details on www.example.com');
    await respond(BYSTANDER_2, id, 'I saw him at the market.');
    const first = await readResponses(id);
    expect(first.responses.map((r) => r.text)).toEqual(['I saw him at the market.']);
    const responseId = db.listHeldResponses()[0]?.response_id as string;
    await page(cookie, 'POST', `/operator/responses/${responseId}/release`);
    const next = await readResponses(id, first.cursor as string);
    expect(next.responses.map((r) => r.text)).toEqual(['details on www.example.com']);
  });

  test('rejecting a held response never delivers it', async () => {
    const cookie = await signIn();
    const id = await releasedReport(cookie);
    await respond(BYSTANDER, id, 'UPI me at rahul@okaxis');
    const responseId = db.listHeldResponses()[0]?.response_id as string;
    const res = await page(cookie, 'POST', `/operator/responses/${responseId}/reject`);
    expect(res.status).toBe(303);
    expect((await readResponses(id)).responses).toEqual([]);
    expect(db.listHeldResponses()).toEqual([]);
    expect((await page(cookie)).html).not.toContain('rahul@okaxis');
    // Final, and it still counts as that device's one response.
    expect((await page(cookie, 'POST', `/operator/responses/${responseId}/release`)).status).toBe(
      409,
    );
    expect((await readResponses(id)).responses).toEqual([]);
    expect((await respond(BYSTANDER, id, 'clean retry')).status).toBe(409);
  });

  test('a response that was never held cannot be decided', async () => {
    const cookie = await signIn();
    const id = await releasedReport(cookie);
    const sent = await respond(BYSTANDER, id, 'I saw him by the bus stop.');
    const responseId = sent.body.response_id as string;
    for (const target of [responseId, '01JB3Z6Q7W8X9Y0ZABCDEFGHJK', 'nonsense']) {
      expect((await page(cookie, 'POST', `/operator/responses/${target}/reject`)).status).toBe(409);
    }
    expect((await readResponses(id)).responses).toHaveLength(1);
  });

  test('a decision on a held response without a session changes nothing', async () => {
    const cookie = await signIn();
    const id = await releasedReport(cookie);
    await respond(BYSTANDER, id, 'pay via PayTM');
    const responseId = db.listHeldResponses()[0]?.response_id as string;
    expect((await page(null, 'POST', `/operator/responses/${responseId}/release`)).status).toBe(
      401,
    );
    expect((await readResponses(id)).responses).toEqual([]);
    expect(db.listHeldResponses()).toHaveLength(1);
  });
});

describe('user-supplied text', () => {
  const NAME = '<script>alert("name")</script>';
  const DESCRIPTION = "\"><img src=x onerror=alert(1)> & 'quoted'";
  const RESPONSE = '</dd><script src="https://evil.example.com/x.js"></script>';

  test('escapeHtml covers every character that can leave text or a quoted attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  test('HTML in a report or a response is shown as text, never as markup', async () => {
    const cookie = await signIn();
    // One hostile report still pending, and one released with a hostile response held on it.
    const id = await submitReport({ person: { name: NAME, description: DESCRIPTION } });
    await page(cookie, 'POST', `/operator/reports/${id}/release`);
    expect((await respond(BYSTANDER, id, RESPONSE)).status).toBe(201);
    await submitReport({ person: { name: NAME, description: DESCRIPTION } });

    const res = await page(cookie);
    expect(res.status).toBe(200);
    expect(res.html).toContain('Pending reports (1)');
    expect(res.html).toContain('Held responses (1)');
    expect(res.html).toContain('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;');
    expect(res.html).toContain(
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; &#39;quoted&#39;',
    );
    expect(res.html).toContain(
      '&lt;/dd&gt;&lt;script src=&quot;https://evil.example.com/x.js&quot;&gt;&lt;/script&gt;',
    );
    // No element the stored text tried to open exists in the page.
    expect(res.html).not.toMatch(/<script/i);
    expect(res.html).not.toMatch(/<img/i);
    expect(res.html).not.toContain('onerror=alert(1)>');
  });

  test('a stored photo that is not a base64 image is not rendered', async () => {
    const cookie = await signIn();
    const id = await submitReport({
      person: {
        name: 'Alex Rivera',
        description: '',
        photo: { mime: 'image/jpeg', w: 2, h: 2, b64: '/9j/4AAQ' },
      },
    });
    // Written past intake validation, as a row from an older or buggy server would be.
    const written = db.updateReportCriteria(
      id,
      1,
      {
        center: submitBody.center,
        radius_m: submitBody.radius_m,
        window: submitBody.window,
        person: {
          name: 'Alex Rivera',
          description: '',
          photo: { mime: 'image/jpeg', w: 2, h: 2, b64: '"><script>alert(1)</script>' },
        },
      },
      nowSec,
    );
    expect(written).toBe(true);
    const res = await page(cookie);
    expect(res.html).toContain('Alex Rivera');
    expect(res.html).not.toMatch(/<img/i);
    expect(res.html).not.toMatch(/<script/i);
  });

  test('the page forbids script and allows only its own stylesheet', async () => {
    const cookie = await signIn();
    const res = await page(cookie);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).not.toContain('unsafe-inline');
    const style = /<style>([\s\S]*?)<\/style>/.exec(res.html)?.[1] as string;
    const hash = createHash('sha256').update(style).digest('base64');
    expect(csp).toContain(`style-src 'sha256-${hash}'`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
