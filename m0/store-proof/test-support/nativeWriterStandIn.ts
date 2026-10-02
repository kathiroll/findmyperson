/**
 * Plays the part of the Kotlin / Swift writer inside Jest. It does NOT use the TypeScript
 * pragma builder: it reads the statements out of the GENERATED Kotlin or Swift source, so if
 * the native constant drifts from the TS one this stand-in writes a file the TS reader rejects.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nodeSqlcipherDriver } from './nodeSqlcipherDriver';
import { CIPHER_PARAMS } from '../src/generated/cipherParams.generated';
import { keyLiteral } from '../src/store/pragmas';

const root = resolve(__dirname, '..');
const KOTLIN = 'android/app/src/main/java/com/storeproof/store/CipherParams.kt';
const SWIFT = 'ios/StoreProof/Store/CipherParams.swift';

/** Every "PRAGMA ..." string literal in the generated native constant, in order. */
export function nativePragmas(platform: 'android' | 'ios'): string[] {
  const src = readFileSync(
    resolve(root, platform === 'android' ? KOTLIN : SWIFT),
    'utf8',
  );
  return [...src.matchAll(/"(PRAGMA [^"]+)"/g)].map(m => m[1]);
}

export async function nativeWrite(opts: {
  platform: 'android' | 'ios';
  path: string;
  keyHex: string;
  label: string;
  tsUtc: number;
  pragmas?: string[];
}): Promise<void> {
  const db = await nodeSqlcipherDriver()({
    path: opts.path,
    key: keyLiteral(opts.keyHex),
  });
  for (const p of opts.pragmas ?? nativePragmas(opts.platform)) {
    await db.execute(p);
  }
  await db.execute(`PRAGMA journal_mode = ${CIPHER_PARAMS.journalMode}`);
  await db.execute(CIPHER_PARAMS.createTableSql);
  await db.execute(CIPHER_PARAMS.insertSql, [opts.tsUtc, opts.label]);
  await db.close();
}
