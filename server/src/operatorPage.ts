import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MAX_PERSON_PHOTOS,
  PersonPhotoSchema,
  QueryIdSchema,
  ResponseIdSchema,
} from '@findmyperson/shared';
import type { ReportRow, ResponseRow, ServerDb } from './db';
import type { ReviewAction } from './lifecycle';
import { decideHeldResponse, type ModerationReason } from './moderation';

/**
 * The operator page: one server-rendered HTML page where the captain reads pending reports and
 * held responses and releases or rejects them. No script, no framework; every button is a form.
 *
 * It adds no rule of its own. A report is decided by the same `reviewReport` the operator API
 * routes use (app.ts, lifecycle.ts) and a held response by `decideHeldResponse` (moderation.ts).
 *
 * TODO(operator-auth): THE ACCESS CONTROL HERE IS A TEMPORARY STUB AND MUST BE REPLACED BY REAL
 * OPERATOR AUTHENTICATION. It is one shared token from the environment (FMP_OPERATOR_WEB_TOKEN):
 * no accounts, no record of who decided what, no rate limit on guesses, no revocation short of
 * changing the token. With the token unset, empty or shorter than
 * MIN_OPERATOR_WEB_TOKEN_CHARS, every request is refused.
 *
 * How the stub works: the login form posts the token; a correct one sets a cookie holding an
 * expiry and an HMAC of it keyed by the token, never the token itself. Every route below checks
 * that cookie in the `onRequest` hook, before any body is read. The cookie is HttpOnly and
 * SameSite=Lax, and a POST the browser marks as coming from another site is refused, so another
 * site cannot press the buttons.
 *
 * Reports and responses are text typed by strangers. Everything goes into the page through the
 * `markup` tag, which escapes every value it is given, and the response carries a
 * Content-Security-Policy that allows no script at all.
 */
export const OPERATOR_PAGE_PATH = '/operator';
export const MIN_OPERATOR_WEB_TOKEN_CHARS = 16;

const LOGIN_PATH = `${OPERATOR_PAGE_PATH}/login`;
const LOGOUT_PATH = `${OPERATOR_PAGE_PATH}/logout`;
const SESSION_COOKIE = 'fmp_operator_session';
const SESSION_TTL_SEC = 12 * 60 * 60;
/** Recorded as `reviewed_by`: the page has one shared token, so it cannot say who. */
const REVIEWED_BY = 'operator-web';

export type ReportReview =
  | { ok: true; report: ReportRow }
  | { ok: false; code: 'not_found' | 'report_not_active'; message: string };

export interface OperatorPageDeps {
  db: ServerDb;
  /** Unix seconds. */
  now: () => number;
  token: string | undefined;
  /** Pending reports, with lazy expiry applied. */
  listPendingReports: () => ReportRow[];
  /** The release/reject implementation of app.ts. */
  reviewReport: (queryId: string, action: ReviewAction, by: string) => ReportReview;
}

/** The token as it will be compared, or null when it is unset, empty or too short to use. */
export function usableOperatorWebToken(raw: string | undefined): string | null {
  const token = (raw ?? '').trim();
  return token.length >= MIN_OPERATOR_WEB_TOKEN_CHARS ? token : null;
}

// --- HTML, escaped by construction -----------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char] as string);
}

/** Markup that is already safe to emit. Only the `markup` tag makes one. */
class Html {
  constructor(readonly text: string) {}
}

type Value = string | number | Html | readonly Html[];

/**
 * Every interpolated value is escaped unless it is itself the result of `markup`, so stored text
 * cannot reach the page unescaped. Attribute values must be written in double quotes. It is not
 * named `html` because Prettier re-indents templates with that tag, and the whitespace matters
 * here: the stylesheet's CSP hash, and descriptions shown with their line breaks.
 */
function markup(strings: TemplateStringsArray, ...values: Value[]): Html {
  let text = strings[0] ?? '';
  values.forEach((value, i) => {
    if (value instanceof Html) {
      text += value.text;
    } else if (typeof value === 'object') {
      text += value.map((part) => part.text).join('');
    } else {
      text += escapeHtml(String(value));
    }
    text += strings[i + 1] ?? '';
  });
  return new Html(text);
}

const EMPTY = new Html('');

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 46rem; padding: 1rem; }
header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
h1 { font-size: 1.3rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
.card { border: 1px solid #8886; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; overflow-wrap: anywhere; }
.card h3 { margin: 0 0 0.5rem; font-size: 1rem; }
.card .photos { float: right; display: flex; gap: 0.5rem; margin: 0 0 0.5rem 0.75rem; }
.card img { width: 96px; height: 96px; object-fit: cover; border-radius: 6px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.2rem 0.75rem; margin: 0; }
dt { opacity: 0.7; }
dd { margin: 0; white-space: pre-wrap; }
.actions { display: flex; gap: 0.5rem; margin-top: 0.75rem; clear: both; }
form { margin: 0; }
button, input { font: inherit; padding: 0.4rem 0.9rem; border-radius: 6px; border: 1px solid #8888; }
button { cursor: pointer; }
button.release { background: #1a7f37; color: #fff; border-color: #1a7f37; }
button.reject { background: #b42318; color: #fff; border-color: #b42318; }
.notice, .error { padding: 0.6rem 0.8rem; border-radius: 6px; }
.notice { background: #1a7f3733; }
.error { background: #b4231833; }
.muted { opacity: 0.7; }
`;

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'none'",
    `style-src 'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`,
    'img-src data:',
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function document(title: string, body: Html): Html {
  return markup`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${new Html(STYLE)}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function utc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function ago(seconds: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - seconds) / 60));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (24 * 60))} days ago`;
}

function phoneLink(phone: string): Html {
  return markup`<a href="tel:${phone}">${phone}</a>`;
}

function actionButton(target: string, action: ReviewAction): Html {
  const label = action === 'release' ? 'Release' : 'Reject';
  return markup`<form method="post" action="${OPERATOR_PAGE_PATH}/${target}/${action}"><button class="${action}" type="submit">${label}</button></form>`;
}

/**
 * Every photo sent with the report, in the reporter's order. The row is read as stored, not as
 * typed: an entry that is not a base64 image is left out, and no more than the cap is shown.
 */
function thumbnails(report: ReportRow): Html {
  const stored: unknown = report.person.photos;
  if (!Array.isArray(stored)) {
    return EMPTY;
  }
  const images = stored.slice(0, MAX_PERSON_PHOTOS).flatMap((entry: unknown, i) => {
    const photo = PersonPhotoSchema.safeParse(entry);
    return photo.success
      ? [
          markup`<img alt="Photo ${i + 1} sent with the report" src="data:${photo.data.mime};base64,${photo.data.b64}">`,
        ]
      : [];
  });
  return images.length === 0 ? EMPTY : markup`<div class="photos">${images}</div>`;
}

function reportCard(report: ReportRow, now: number): Html {
  const target = `reports/${report.query_id}`;
  // An ended or expired report cannot be released (app.ts), so it is not offered.
  const actions =
    report.status === 'active'
      ? markup`${actionButton(target, 'release')}${actionButton(target, 'reject')}`
      : markup`${actionButton(target, 'reject')}<span class="muted">This report is ${report.status}; it can no longer be released.</span>`;
  return markup`<article class="card">
${thumbnails(report)}
<h3>${report.person.name}</h3>
<dl>
<dt>Reporter phone</dt><dd>${phoneLink(report.reporter_phone)}</dd>
<dt>Submitted</dt><dd>${utc(report.created_at)} (${ago(report.created_at, now)})</dd>
<dt>Last seen</dt><dd>within ${report.radius_m} m of ${report.center.lat}, ${report.center.lon}, between ${utc(report.window.from)} and ${utc(report.window.to)}</dd>
<dt>Description</dt><dd>${report.person.description}</dd>
<dt>Report</dt><dd><code>${report.query_id}</code></dd>
</dl>
<div class="actions">${actions}</div>
</article>
`;
}

const HELD_REASONS: Readonly<Record<ModerationReason, string>> = {
  url: 'contains a link',
  crypto_address: 'contains a crypto address',
  upi_id: 'contains a UPI id (or an email address)',
  payment_phrase: 'asks for or mentions a payment',
};

function heldReason(reason: string | null): string {
  if (reason === null) return 'not recorded';
  return Object.hasOwn(HELD_REASONS, reason) ? HELD_REASONS[reason as ModerationReason] : reason;
}

function responseCard(response: ResponseRow, report: ReportRow | null, now: number): Html {
  const target = `responses/${response.response_id}`;
  const about =
    report === null
      ? markup`<code>${response.query_id}</code> (no longer on record)`
      : markup`${report.person.name}, reporter ${phoneLink(report.reporter_phone)} <code>${report.query_id}</code>`;
  const phone =
    response.phone === null
      ? EMPTY
      : markup`<dt>Responder phone</dt><dd>${phoneLink(response.phone)}</dd>`;
  return markup`<article class="card">
<dl>
<dt>Response</dt><dd>${response.text}</dd>
${phone}
<dt>For report</dt><dd>${about}</dd>
<dt>Held because</dt><dd>${heldReason(response.held_reason)}</dd>
<dt>Received</dt><dd>${utc(response.received_at)} (${ago(response.received_at, now)})</dd>
</dl>
<div class="actions">${actionButton(target, 'release')}${actionButton(target, 'reject')}</div>
</article>
`;
}

function loginPage(error?: string): Html {
  return document(
    'Operator sign-in',
    markup`<h1>Operator review</h1>
${error === undefined ? EMPTY : markup`<p class="error">${error}</p>`}
<form method="post" action="${LOGIN_PATH}">
<p><label>Operator token <input type="password" name="token" autocomplete="current-password" required autofocus></label></p>
<p><button type="submit">Sign in</button></p>
</form>`,
  );
}

const DISABLED_PAGE = document(
  'Operator page disabled',
  markup`<h1>Operator page disabled</h1>
<p>FMP_OPERATOR_WEB_TOKEN is not set on the server, or is shorter than ${MIN_OPERATOR_WEB_TOKEN_CHARS} characters, so this page refuses every request.</p>`,
);

const CROSS_SITE_PAGE = document(
  'Refused',
  markup`<h1>Refused</h1>
<p>That request came from another site. Open <a href="${OPERATOR_PAGE_PATH}">the operator page</a> and use its buttons.</p>`,
);

/** What `?done=` may say after a decision. Fixed text, so a crafted link cannot put words here. */
const NOTICES: ReadonlyMap<string, string> = new Map([
  ['report-release', 'Report released. It is now broadcastable.'],
  ['report-reject', 'Report rejected. It will never be broadcast.'],
  ['response-release', 'Response released. The reporter can now read it.'],
  ['response-reject', 'Response rejected. It will never be delivered.'],
]);

// --- the access stub -------------------------------------------------------------------------

/** Compares digests, so neither the length nor the content of `expected` leaks through timing. */
function sameString(supplied: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

function sessionSignature(token: string, expiresAt: number): string {
  return createHmac('sha256', token).update(`fmp-operator-session:${expiresAt}`).digest('hex');
}

function issueSession(token: string, now: number): string {
  const expiresAt = now + SESSION_TTL_SEC;
  return `${expiresAt}.${sessionSignature(token, expiresAt)}`;
}

function sessionIsValid(token: string, value: string | null, now: number): boolean {
  const parts = /^([0-9]{1,12})\.([0-9a-f]{64})$/.exec(value ?? '');
  if (parts === null) {
    return false;
  }
  const expiresAt = Number(parts[1]);
  return now < expiresAt && sameString(parts[2] as string, sessionSignature(token, expiresAt));
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** `Secure` whenever the browser reached us over TLS, directly or through a proxy. */
function cookieHeader(req: FastifyRequest, value: string, maxAgeSec: number): string {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    ?.trim();
  const secure = req.protocol === 'https' || forwarded === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=${OPERATOR_PAGE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function isCrossSite(req: FastifyRequest): boolean {
  const site = req.headers['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

// --- routes ----------------------------------------------------------------------------------

function send(reply: FastifyReply, status: number, page: Html): FastifyReply {
  return reply.code(status).headers(PAGE_HEADERS).type('text/html; charset=utf-8').send(page.text);
}

function redirect(reply: FastifyReply, location: string): FastifyReply {
  return reply.code(303).headers(PAGE_HEADERS).header('location', location).send();
}

export function registerOperatorPage(app: FastifyInstance, deps: OperatorPageDeps): void {
  const { db, now } = deps;
  const token = usableOperatorWebToken(deps.token);

  function dashboard(message: { notice?: string; error?: string } = {}): Html {
    const at = now();
    // Newest first, both lists.
    const reports = deps.listPendingReports().reverse();
    const responses = db.listHeldResponses().reverse();
    const reportCards =
      reports.length === 0
        ? markup`<p class="muted">No report is waiting for review.</p>`
        : reports.map((report) => reportCard(report, at));
    const responseCards =
      responses.length === 0
        ? markup`<p class="muted">No response is held.</p>`
        : responses.map((response) => responseCard(response, db.getReport(response.query_id), at));
    return document(
      'Operator review',
      markup`<header><h1>Operator review</h1><form method="post" action="${LOGOUT_PATH}"><button type="submit">Sign out</button></form></header>
${message.notice === undefined ? EMPTY : markup`<p class="notice">${message.notice}</p>`}
${message.error === undefined ? EMPTY : markup`<p class="error">${message.error}</p>`}
<section>
<h2>Pending reports (${reports.length})</h2>
${reportCards}
</section>
<section>
<h2>Held responses (${responses.length})</h2>
${responseCards}
</section>`,
    );
  }

  // Its own scope, so the form parser and the hook touch no API route.
  void app.register((scope, _options, done) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_req, body, parsed) => {
        parsed(null, Object.fromEntries(new URLSearchParams(body as string)));
      },
    );

    // THE GATE. Runs for every route of this scope before the body is read.
    scope.addHook('onRequest', async (req, reply) => {
      if (token === null) {
        return send(reply, 403, DISABLED_PAGE);
      }
      if (req.method !== 'GET' && isCrossSite(req)) {
        return send(reply, 403, CROSS_SITE_PAGE);
      }
      if (
        req.routeOptions.url !== LOGIN_PATH &&
        !sessionIsValid(token, readCookie(req.headers.cookie, SESSION_COOKIE), now())
      ) {
        return send(reply, 401, loginPage());
      }
      return undefined;
    });

    scope.post(LOGIN_PATH, (req, reply) => {
      const supplied = (req.body as { token?: unknown } | undefined)?.token;
      if (token === null || typeof supplied !== 'string' || !sameString(supplied.trim(), token)) {
        req.log.warn({ event: 'operator_web.login_failed' }, 'operator page: wrong token');
        return send(reply, 401, loginPage('That token is not right.'));
      }
      req.log.info({ event: 'operator_web.login' }, 'operator page: signed in');
      reply.header('set-cookie', cookieHeader(req, issueSession(token, now()), SESSION_TTL_SEC));
      return redirect(reply, OPERATOR_PAGE_PATH);
    });

    scope.post(LOGOUT_PATH, (req, reply) => {
      reply.header('set-cookie', cookieHeader(req, '', 0));
      return redirect(reply, OPERATOR_PAGE_PATH);
    });

    for (const url of [OPERATOR_PAGE_PATH, `${OPERATOR_PAGE_PATH}/`]) {
      scope.get(url, (req, reply) => {
        const notice = NOTICES.get(String((req.query as { done?: unknown }).done));
        return send(reply, 200, dashboard(notice === undefined ? {} : { notice }));
      });
    }

    for (const action of ['release', 'reject'] as const) {
      scope.post(`${OPERATOR_PAGE_PATH}/reports/:id/${action}`, (req, reply) => {
        const id = QueryIdSchema.safeParse((req.params as { id?: string }).id);
        const outcome: ReportReview = id.success
          ? deps.reviewReport(id.data, action, REVIEWED_BY)
          : { ok: false, code: 'not_found', message: 'no such report' };
        if (!outcome.ok) {
          const status = outcome.code === 'not_found' ? 404 : 409;
          return send(reply, status, dashboard({ error: `Nothing changed: ${outcome.message}.` }));
        }
        return redirect(reply, `${OPERATOR_PAGE_PATH}?done=report-${action}`);
      });

      scope.post(`${OPERATOR_PAGE_PATH}/responses/:id/${action}`, (req, reply) => {
        const id = ResponseIdSchema.safeParse((req.params as { id?: string }).id);
        if (!id.success || !decideHeldResponse(db, id.data, action, now())) {
          const error = 'Nothing changed: that response is not waiting for a decision.';
          return send(reply, 409, dashboard({ error }));
        }
        req.log.info(
          {
            event: action === 'release' ? 'response.released' : 'response.rejected',
            response_id: id.data,
            by: REVIEWED_BY,
          },
          'held response reviewed',
        );
        return redirect(reply, `${OPERATOR_PAGE_PATH}?done=response-${action}`);
      });
    }

    done();
  });
}
