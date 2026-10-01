import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Returns the 32-byte store key as 64 hex characters, creating and persisting it on first
   * call (Keychain AfterFirstUnlockThisDeviceOnly on iOS, Android Keystore wrapped key on
   * Android). The native writer fetches the same key itself; JS needs it only because op-sqlite
   * takes the key as a string.
   */
  getOrCreateKeyHex(): Promise<string>;

  /**
   * After `delaySeconds` (0 = now), opens the store file at `dbPath` natively with the pinned
   * cipher parameters and inserts one row (ts = now, label). Resolves with the epoch-seconds
   * timestamp written. Rejects with a message naming the failed step if the open or the
   * parameter check fails. A non-zero delay exists so a tester can background the app and lock
   * the phone while the write is still pending (see README, device checks).
   */
  writeProbeRow(
    dbPath: string,
    label: string,
    delaySeconds: number,
  ): Promise<number>;

  /** Absolute path of the directory holding the store file. */
  getDatabaseDirectory(): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeStoreProof');
