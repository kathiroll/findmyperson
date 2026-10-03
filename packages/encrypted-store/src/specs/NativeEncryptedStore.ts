/**
 * Turbo Native Module spec for the store's key and files. CODEGEN INPUT.
 *
 * React Native's codegen reads this file and emits the interface the Kotlin module and the
 * ObjC++ module implement (`codegenConfig` in ../../package.json). Committed copies of that
 * output live in ../../contracts/ and codegen.test.ts keeps them in step.
 *
 * The module is deliberately small. It is the part of the store that cannot be written in
 * TypeScript: the key lives in the Keychain or the Keystore, and the files live in a directory
 * only native code can name. Everything else (opening, checking the cipher parameters,
 * migrating, reading, writing) is TypeScript over op-sqlite, in ../openStore.ts.
 *
 * `getOrCreateStoreKeyHex` and `getStoreDirectory` also exist on the capture module
 * (@findmyperson/native-location-capture). Both modules answer from the same native code, the
 * `EncryptedStore` class of this package, so the two can never disagree.
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Returns the 32-byte store key as 64 hex characters, creating and persisting it on first
   * call. iOS: a Keychain generic password, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly.
   * Android: wrapped by an AES-GCM key in the Android Keystore that requires neither an
   * unlocked device nor user authentication. Both are readable while the phone is locked, once
   * it has been unlocked after boot, and neither leaves the device.
   *
   * Rejects with `key_unavailable` when the key exists but cannot be read (before the first
   * unlock after a reboot, or the Keystore lost its wrapping key). It never answers that by
   * making a new key: that would orphan every row already stored.
   *
   * The key is a secret. JavaScript needs it only because op-sqlite takes the key as a string;
   * never log it, store it or send it anywhere.
   */
  getOrCreateStoreKeyHex(): Promise<string>;

  /**
   * Absolute path of the directory that holds the store, created and excluded from backup
   * before this resolves. The file inside it is STORE_FILE_NAME from @findmyperson/shared.
   * Rejects with `backup_not_excluded` if the directory cannot be kept out of backups: the
   * store is then not opened at all.
   */
  getStoreDirectory(): Promise<string>;

  /**
   * "Delete all my data" (plan 4.7), the native half: closes the native connection, deletes
   * the store file with its -wal and -shm files, and deletes the key. The next
   * `getOrCreateStoreKeyHex` makes a new key, so the old file contents, wherever a copy may
   * survive, can never be read again. Works when the store or the key is already unusable.
   *
   * Close the JavaScript connection first. Call it through `deleteAllData` in this package,
   * which does that and then recreates the store.
   */
  deleteAllData(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeEncryptedStore');
