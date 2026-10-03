import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STORE_FILE_NAME } from '@findmyperson/shared';
import { STORE_FILE_SUFFIXES } from '../location';
import type { StoreVault } from '../openStore';

export interface TestVault extends StoreVault {
  readonly directory: string;
  /** The key as the vault holds it now, without creating one. Null before first use and after a delete. */
  currentKeyHex(): string | null;
}

/**
 * TEST SUPPORT. What the native module does, in memory and on a directory the test owns:
 * makes the key on first use, keeps it until deleteAllData, and then removes the three files
 * and forgets the key. A new vault over the same directory with `keyHex` set plays an app
 * restart, where the Keychain or Keystore still has the key.
 */
export function createTestVault(directory: string, options: { keyHex?: string } = {}): TestVault {
  let keyHex = options.keyHex ?? null;
  return {
    directory,
    currentKeyHex: () => keyHex,
    async getOrCreateStoreKeyHex() {
      keyHex ??= randomBytes(32).toString('hex');
      return keyHex;
    },
    async getStoreDirectory() {
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    async deleteAllData() {
      for (const suffix of STORE_FILE_SUFFIXES) {
        rmSync(join(directory, STORE_FILE_NAME + suffix), { force: true });
      }
      keyHex = null;
    },
  };
}
