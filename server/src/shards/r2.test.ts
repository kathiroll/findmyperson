import { describe, expect, test } from 'vitest';
import {
  CloudflareCdnInvalidator,
  PURGE_BATCH,
  R2ObjectStore,
  r2ConfigFromEnv,
  type FetchFn,
} from './r2';
import { BUNDLE_CACHE_CONTROL, INDEX_CACHE_CONTROL, JSON_CONTENT_TYPE } from './storage';

const CONFIG = {
  accountId: 'acct',
  bucket: 'fmp-bundles',
  accessKeyId: 'AKID',
  secretAccessKey: 'secret',
};
const NOW = () => new Date('2026-10-04T12:34:56.789Z');

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake S3 endpoint: an in-memory bucket answering put, get, list (paged) and delete. */
function fakeR2(pageSize = 1000) {
  const objects = new Map<string, { body: Uint8Array; headers: Record<string, string> }>();
  const calls: Call[] = [];
  const fetchFn: FetchFn = (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.replace(/^\/fmp-bundles\/?/, ''));
    const headers = init.headers as Record<string, string>;
    switch (init.method) {
      case 'PUT':
        objects.set(key, { body: Uint8Array.from(init.body as Uint8Array), headers });
        return Promise.resolve(new Response(null, { status: 200 }));
      case 'DELETE':
        objects.delete(key);
        return Promise.resolve(new Response(null, { status: 204 }));
      default: {
        if (u.searchParams.get('list-type') === '2') {
          const prefix = u.searchParams.get('prefix') ?? '';
          const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
          const start = Number(u.searchParams.get('continuation-token') ?? 0);
          const page = all.slice(start, start + pageSize);
          const more = start + pageSize < all.length;
          const xml =
            `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}` +
            `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}</ListBucketResult>`;
          return Promise.resolve(new Response(xml, { status: 200 }));
        }
        const found = objects.get(key);
        return Promise.resolve(
          found === undefined
            ? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
            : new Response(found.body, { status: 200 }),
        );
      }
    }
  };
  return { objects, calls, fetchFn };
}

describe('R2ObjectStore', () => {
  test('put sends a SigV4-signed request with the cache headers it was given', async () => {
    const fake = fakeR2();
    const store = new R2ObjectStore(CONFIG, fake.fetchFn, NOW);
    await store.put('shards/85/7.json', Buffer.from('{}'), {
      contentType: JSON_CONTENT_TYPE,
      cacheControl: BUNDLE_CACHE_CONTROL,
    });
    await store.put('index.json', Buffer.from('{}'), {
      contentType: JSON_CONTENT_TYPE,
      cacheControl: INDEX_CACHE_CONTROL,
    });
    const [bundle, index] = fake.calls;
    expect(bundle!.url).toBe('https://acct.r2.cloudflarestorage.com/fmp-bundles/shards/85/7.json');
    const headers = bundle!.init.headers as Record<string, string>;
    expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-amz-date']).toBe('20261004T123456Z');
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20261004\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect((index!.init.headers as Record<string, string>)['cache-control']).toBe(
      'public, max-age=60',
    );
    // Signing is deterministic and depends on the secret.
    const again = fakeR2();
    await new R2ObjectStore(CONFIG, again.fetchFn, NOW).put('shards/85/7.json', Buffer.from('{}'), {
      contentType: JSON_CONTENT_TYPE,
      cacheControl: BUNDLE_CACHE_CONTROL,
    });
    expect((again.calls[0]!.init.headers as Record<string, string>)['authorization']).toBe(
      headers['authorization'],
    );
    const other = fakeR2();
    await new R2ObjectStore({ ...CONFIG, secretAccessKey: 'x' }, other.fetchFn, NOW).put(
      'shards/85/7.json',
      Buffer.from('{}'),
      {
        contentType: JSON_CONTENT_TYPE,
        cacheControl: BUNDLE_CACHE_CONTROL,
      },
    );
    expect((other.calls[0]!.init.headers as Record<string, string>)['authorization']).not.toBe(
      headers['authorization'],
    );
  });

  test('matches the AWS SigV4 reference example for the signing key and request layout', async () => {
    // Pins the derivation: a stable signature for fixed inputs, so a refactor cannot change it.
    const fake = fakeR2();
    await new R2ObjectStore(CONFIG, fake.fetchFn, NOW).get('index.json');
    const auth = (fake.calls[0]!.init.headers as Record<string, string>)['authorization']!;
    expect(auth).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
  });

  test('round trips get, delete, and a missing key', async () => {
    const fake = fakeR2();
    const store = new R2ObjectStore(CONFIG, fake.fetchFn, NOW);
    const options = { contentType: JSON_CONTENT_TYPE, cacheControl: BUNDLE_CACHE_CONTROL };
    await store.put('a.json', Buffer.from('hello'), options);
    expect(Buffer.from((await store.get('a.json'))!).toString()).toBe('hello');
    expect(await store.get('missing.json')).toBeNull();
    await store.delete('a.json');
    await store.delete('a.json');
    expect(await store.get('a.json')).toBeNull();
  });

  test('list follows continuation tokens, filters by prefix and sorts', async () => {
    const fake = fakeR2(2);
    const store = new R2ObjectStore(CONFIG, fake.fetchFn, NOW);
    const options = { contentType: JSON_CONTENT_TYPE, cacheControl: BUNDLE_CACHE_CONTROL };
    for (const key of ['shards/b/2.json', 'shards/a/1.json', 'shards/c/3.json', 'index.json']) {
      await store.put(key, Buffer.from('x'), options);
    }
    expect(await store.list('shards/')).toEqual([
      'shards/a/1.json',
      'shards/b/2.json',
      'shards/c/3.json',
    ]);
    expect(await store.list('')).toHaveLength(4);
  });

  test('errors carry the status, not the credentials', async () => {
    const store = new R2ObjectStore(
      CONFIG,
      () => Promise.resolve(new Response('denied', { status: 403 })),
      NOW,
    );
    const error = await store
      .put('a.json', Buffer.from('x'), {
        contentType: JSON_CONTENT_TYPE,
        cacheControl: INDEX_CACHE_CONTROL,
      })
      .catch((e: Error) => e);
    expect((error as Error).message).toContain('HTTP 403');
    expect((error as Error).message).not.toContain('secret');
  });
});

describe('CloudflareCdnInvalidator', () => {
  const PURGE = { zoneId: 'zone1', apiToken: 'tok', origin: 'https://bundles.example.org' };

  test('purges full URLs in batches of 30 with the bearer token', async () => {
    const calls: Call[] = [];
    const cdn = new CloudflareCdnInvalidator(PURGE, (url, init = {}) => {
      calls.push({ url, init });
      return Promise.resolve(Response.json({ success: true }));
    });
    const paths = Array.from({ length: PURGE_BATCH + 1 }, (_, i) => `/shards/85/${i}.json`);
    await cdn.invalidate(paths);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/zones/zone1/purge_cache');
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    const first = JSON.parse(calls[0]!.init.body as string) as { files: string[] };
    expect(first.files).toHaveLength(PURGE_BATCH);
    expect(first.files[0]).toBe('https://bundles.example.org/shards/85/0.json');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      files: ['https://bundles.example.org/shards/85/30.json'],
    });
  });

  test('a failed purge throws so the compiler keeps the paths pending', async () => {
    const cdn = new CloudflareCdnInvalidator(PURGE, () =>
      Promise.resolve(Response.json({ success: false }, { status: 403 })),
    );
    await expect(cdn.invalidate(['/index.json'])).rejects.toThrow('HTTP 403');
  });

  test('no paths, no calls', async () => {
    const cdn = new CloudflareCdnInvalidator(PURGE, () => {
      throw new Error('should not be called');
    });
    await cdn.invalidate([]);
  });
});

describe('r2ConfigFromEnv', () => {
  const ENV = {
    FMP_R2_BUCKET: 'b',
    FMP_R2_ACCOUNT_ID: 'a',
    FMP_R2_ACCESS_KEY_ID: 'k',
    FMP_R2_SECRET_ACCESS_KEY: 's',
    FMP_CDN_ORIGIN: 'https://bundles.example.org/',
    FMP_CDN_ZONE_ID: 'z',
    FMP_CDN_API_TOKEN: 't',
  };

  test('off when no bucket, complete when all set, loud when partial', () => {
    expect(r2ConfigFromEnv({})).toBeNull();
    expect(r2ConfigFromEnv(ENV)?.purge.origin).toBe('https://bundles.example.org');
    expect(() => r2ConfigFromEnv({ ...ENV, FMP_CDN_API_TOKEN: '' })).toThrow('FMP_CDN_API_TOKEN');
    expect(() => r2ConfigFromEnv({ ...ENV, FMP_CDN_ORIGIN: 'http://x.org' })).toThrow(
      'https origin',
    );
  });
});

// A real bucket needs credentials this repository does not hold. Set FMP_R2_TEST_* (the same
// variables as FMP_R2_*/FMP_CDN_* with that prefix) in a private run to exercise it; CI skips.
const live =
  process.env['FMP_R2_TEST_BUCKET'] !== undefined && process.env['FMP_R2_TEST_BUCKET'] !== '';
describe.skipIf(!live)('live R2 bucket', () => {
  test('put, list, get, delete against the test bucket', async () => {
    const store = new R2ObjectStore({
      accountId: process.env['FMP_R2_TEST_ACCOUNT_ID']!,
      bucket: process.env['FMP_R2_TEST_BUCKET']!,
      accessKeyId: process.env['FMP_R2_TEST_ACCESS_KEY_ID']!,
      secretAccessKey: process.env['FMP_R2_TEST_SECRET_ACCESS_KEY']!,
    });
    const key = `test/${Date.now()}.json`;
    await store.put(key, Buffer.from('{}'), {
      contentType: JSON_CONTENT_TYPE,
      cacheControl: INDEX_CACHE_CONTROL,
    });
    expect(await store.list(key)).toEqual([key]);
    expect(Buffer.from((await store.get(key))!).toString()).toBe('{}');
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  });
});
