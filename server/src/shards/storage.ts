import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Where the compiler publishes, and how it tells the CDN (plan 7.4).
 *
 * THE LAYOUT, which the device fetcher targets. Object keys are the paths defined in
 * @findmyperson/shared (payload/bundle.ts) without their leading slash:
 *
 *   index.json                       the signed index: every live shard and its generation
 *   shards/<h3 cell>/<generation>.json   one signed bundle; <h3 cell> is res 5 or res 3
 *
 * A bundle key is written once and never rewritten with different bytes: a new generation is a
 * new key. So a bundle can be cached for as long as it exists, and only index.json is ever
 * replaced in place. Superseded and emptied bundles are deleted on publish, so an ended report
 * stops being served; a device holding a stale index that gets a 404 for a bundle re-reads the
 * index.
 *
 * Providers: the Cloudflare R2 store and cache purge are in r2.ts. This file has the two
 * interfaces, a store over a directory (what a single box serving static files needs), and a CDN
 * stub that only logs, used when R2 is not configured.
 */

/** Cache lifetimes the origin or bucket should serve. The directory store cannot carry them. */
export const BUNDLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Short, so a failed invalidation delays a new report by a minute at most. */
export const INDEX_CACHE_CONTROL = 'public, max-age=60';
export const JSON_CONTENT_TYPE = 'application/json';

export interface PutOptions {
  contentType: string;
  cacheControl: string;
}

export interface ObjectStore {
  /** Replaces the object atomically: a reader sees the old bytes or the new, never a mix. */
  put(key: string, body: Uint8Array, options: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Every key that starts with `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
  /** Deleting a key that does not exist is not an error. */
  delete(key: string): Promise<void>;
}

export interface CdnInvalidator {
  /** `paths` are URL paths from the CDN origin, each with its leading slash. */
  invalidate(paths: readonly string[]): Promise<void>;
}

export interface PublishLog {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

/**
 * STUB, for deployments without R2 (see r2.ts). Writes one `shards.cdn_invalidate` log event and
 * purges nothing. Until a real invalidator is used a replaced index.json is stale at the edge for INDEX_CACHE_CONTROL,
 * and a deleted bundle stays cached at the edge until the CDN's own expiry.
 */
export function createLoggingCdnInvalidator(log: PublishLog): CdnInvalidator {
  return {
    invalidate(paths) {
      log.warn(
        { event: 'shards.cdn_invalidate', paths: [...paths] },
        'no CDN adapter is configured; these paths were NOT purged',
      );
      return Promise.resolve();
    },
  };
}

/** For tests and dry runs. Records every write so a test can assert that nothing was rewritten. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  /** The options of the latest put of each key: what a bucket would serve as headers. */
  readonly options = new Map<string, PutOptions>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];

  put(key: string, body: Uint8Array, options: PutOptions): Promise<void> {
    this.objects.set(key, Uint8Array.from(body));
    this.options.set(key, options);
    this.puts.push(key);
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort());
  }

  delete(key: string): Promise<void> {
    if (this.objects.delete(key)) {
      this.deletes.push(key);
    }
    return Promise.resolve();
  }
}

const KEY_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Objects as files under one directory, which a static file server or a CDN origin serves as
 * is. Keys map to paths one to one. A put writes a temporary file beside the target and renames
 * it over, so a reader never sees a half-written bundle.
 */
export class FileSystemObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Keys are plain relative paths. Anything that could leave the root is refused. */
  private pathOf(key: string): string {
    const segments = key.split('/');
    if (!segments.every((segment) => KEY_SEGMENT.test(segment))) {
      throw new RangeError(`not a valid object key: ${JSON.stringify(key)}`);
    }
    return join(this.root, ...segments);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(dirname(target), { recursive: true });
    // The leading dot keeps a temporary file out of list() and out of a valid key.
    const temporary = join(dirname(target), `.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, body);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return Uint8Array.from(await readFile(this.pathOf(key)));
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    const keys: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) {
        continue;
      }
      const directory = relative(this.root, entry.parentPath).split(sep).filter(Boolean);
      const key = [...directory, entry.name].join('/');
      if (key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys.sort();
  }

  async delete(key: string): Promise<void> {
    const target = this.pathOf(key);
    await rm(target, { force: true });
    // Drop a shard's directory once its last generation is gone. Failing here only leaves an
    // empty directory behind (it is not empty, or it is the root).
    if (key.includes('/')) {
      await rmdir(dirname(target)).catch(() => undefined);
    }
  }
}
