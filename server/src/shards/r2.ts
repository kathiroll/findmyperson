import { createHash, createHmac } from 'node:crypto';
import type { CdnInvalidator, ObjectStore, PutOptions } from './storage';

/**
 * Cloudflare R2 as the shard store, and Cloudflare's cache purge as the CDN (plan 7.4).
 *
 * R2 speaks the S3 API, so the store signs plain S3 requests (SigV4, region `auto`) with
 * node:crypto and `fetch`: no SDK dependency, and tests swap `fetch` for a fake. The bucket is
 * served to devices through an R2 custom domain on a Cloudflare zone, so the purge is a call to
 * the Cloudflare API for that zone, not a separate CDN's.
 *
 * Headers: put() stores the Content-Type and Cache-Control it is given, which the compiler
 * sets to immutable for bundle paths and to 60 s for index.json, and R2 serves them back as is.
 *
 * Configuration is environment only; see r2ConfigFromEnv.
 */

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface CloudflarePurgeConfig {
  zoneId: string;
  /** Token with the Zone > Cache Purge permission on that zone, nothing else. */
  apiToken: string;
  /** Public origin the devices fetch from, no trailing slash: https://bundles.example.org */
  origin: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function need(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required when FMP_R2_BUCKET is set`);
  }
  return value;
}

/** The R2 and purge configuration, or null when FMP_R2_BUCKET is unset (R2 publishing is off). */
export function r2ConfigFromEnv(env: Env): { r2: R2Config; purge: CloudflarePurgeConfig } | null {
  const bucket = env['FMP_R2_BUCKET'];
  if (bucket === undefined || bucket === '') {
    return null;
  }
  const origin = need(env, 'FMP_CDN_ORIGIN').replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+$/.test(origin)) {
    throw new Error(
      'FMP_CDN_ORIGIN must be an https origin with no path, like https://bundles.example.org',
    );
  }
  return {
    r2: {
      accountId: need(env, 'FMP_R2_ACCOUNT_ID'),
      bucket,
      accessKeyId: need(env, 'FMP_R2_ACCESS_KEY_ID'),
      secretAccessKey: need(env, 'FMP_R2_SECRET_ACCESS_KEY'),
    },
    purge: {
      zoneId: need(env, 'FMP_CDN_ZONE_ID'),
      apiToken: need(env, 'FMP_CDN_API_TOKEN'),
      origin,
    },
  };
}

const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it. */
const encode = (text: string): string =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export class R2ObjectStore implements ObjectStore {
  private readonly host: string;

  constructor(
    private readonly config: R2Config,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.host = `${config.accountId}.r2.cloudflarestorage.com`;
  }

  private async request(
    method: string,
    key: string,
    query: Record<string, string>,
    body: Uint8Array | undefined,
    extra: Record<string, string>,
  ): Promise<Response> {
    const amzDate = this.now()
      .toISOString()
      .replace(/[-:]|\.\d{3}/g, '');
    const day = amzDate.slice(0, 8);
    const path = `/${encode(this.config.bucket)}${key === '' ? '' : `/${key.split('/').map(encode).join('/')}`}`;
    const canonicalQuery = Object.entries(query)
      .map(([k, v]) => [encode(k), encode(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const payloadHash = sha256Hex(body ?? '');
    const headers: Record<string, string> = {
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${day}/auto/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, day), 'auto'), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    headers['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    delete headers['host']; // fetch sets it from the URL
    const url = `https://${this.host}${path}${canonicalQuery === '' ? '' : `?${canonicalQuery}`}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = body as unknown as NonNullable<RequestInit['body']>;
    }
    return this.fetchFn(url, init);
  }

  private async fail(action: string, response: Response): Promise<never> {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`R2 ${action} failed: HTTP ${response.status} ${detail}`);
  }

  async put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    const response = await this.request('PUT', key, {}, body, {
      'content-type': options.contentType,
      'cache-control': options.cacheControl,
    });
    if (!response.ok) {
      await this.fail(`put ${key}`, response);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.request('GET', key, {}, undefined, {});
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      await this.fail(`get ${key}`, response);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token !== undefined) {
        query['continuation-token'] = token;
      }
      const response = await this.request('GET', '', query, undefined, {});
      if (!response.ok) {
        await this.fail(`list ${prefix}`, response);
      }
      const xml = await response.text();
      for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
        keys.push(decodeXml(match[1]!));
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
      token = truncated && next !== null ? decodeXml(next[1]!) : undefined;
    } while (token !== undefined);
    return keys.sort();
  }

  async delete(key: string): Promise<void> {
    const response = await this.request('DELETE', key, {}, undefined, {});
    if (!response.ok && response.status !== 404) {
      await this.fail(`delete ${key}`, response);
    }
  }
}

/** Cloudflare accepts at most 30 URLs per purge call on every plan. */
export const PURGE_BATCH = 30;

export class CloudflareCdnInvalidator implements CdnInvalidator {
  constructor(
    private readonly config: CloudflarePurgeConfig,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async invalidate(paths: readonly string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += PURGE_BATCH) {
      const files = paths.slice(i, i + PURGE_BATCH).map((path) => `${this.config.origin}${path}`);
      const response = await this.fetchFn(
        `https://api.cloudflare.com/client/v4/zones/${encode(this.config.zoneId)}/purge_cache`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ files }),
        },
      );
      const result = (await response.json().catch(() => null)) as { success?: boolean } | null;
      if (!response.ok || result?.success !== true) {
        // The compiler keeps these paths pending and retries them on the next pass.
        throw new Error(`Cloudflare cache purge failed: HTTP ${response.status}`);
      }
    }
  }
}
